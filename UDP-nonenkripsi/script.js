const dgram = require('dgram');
const WebSocket = require('ws');
const http = require('http');
// Removed encryption/decryption import
const fs = require('fs');
const path = require('path');

const udpSocket = dgram.createSocket('udp4');

// PID Controller Parameters - Tuned values
const PID = {
    Kp: 1.7,      // Proportional gain
    Ki: 0.3,     // Integral gain
    Kd: 0.17,     // Derivative gain
    min_pwm: 12,  // Minimum PWM to overcome static friction
    max_pwm: 50,  // Maximum PWM output
    stop_margin: 0.017,  // ~1 degree
    integral: 0,
    prev_error: 0,
    prev_time: Date.now(),
    target_angle: null,
    current_angle: 0,
    integral_window: [],  // For windowed integral control
    max_integral: 5.0    // Anti-windup limit
};

// Store device information
const deviceState = {
    port: 8766,
    address: null,
    authenticated: false,
    hasSetpoint: false
};

// Create HTTP server for web interface
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    }
});

function calculatePID(targetAngle, currentAngle) {
    if (targetAngle === null) {
        return { pwm: 0, error: 0 };
    }

    const current_time = Date.now();
    const dt = (current_time - PID.prev_time) / 1000;  // Convert to seconds
    const error = targetAngle - currentAngle;

    // Anti-windup: Only accumulate integral when within reasonable range
    const maxIntegralError = 1.0; // About 57 degrees
    if (Math.abs(error) < maxIntegralError) {
        // Windowed integral control
        PID.integral_window.push({ error: error, dt: dt });
        if (PID.integral_window.length > 30) { // Keep last 30 samples
            PID.integral_window.shift();
        }
        
        // Calculate integral over window
        PID.integral = PID.integral_window.reduce((sum, sample) => 
            sum + sample.error * sample.dt, 0);
        
        // Apply anti-windup limit
        PID.integral = Math.max(Math.min(PID.integral, PID.max_integral), -PID.max_integral);
    } else {
        // Reset integral when error is too large
        PID.integral = 0;
        PID.integral_window = [];
    }

    // Calculate derivative with filtering
    const derivative = dt > 0 ? (error - PID.prev_error) / dt : 0;
    
    // PID output calculation
    let output = (PID.Kp * error) + (PID.Ki * PID.integral) + (PID.Kd * derivative);

    // Dynamic PWM scaling based on error magnitude
    const errorDegrees = Math.abs(error * 180 / Math.PI);
    let maxPwm;
    
    if (errorDegrees > 30) {
        // Full power for large errors
        maxPwm = PID.max_pwm;
    } else if (errorDegrees > 10) {
        // Reduced power for medium errors
        maxPwm = PID.max_pwm * 0.7;
    } else {
        // Fine control for small errors
        maxPwm = PID.max_pwm * 0.4;
    }

    // Minimum PWM handling
    if (Math.abs(error) > PID.stop_margin) {
        // Ensure minimum PWM for movement
        if (Math.abs(output) < PID.min_pwm) {
            output = Math.sign(output) * PID.min_pwm;
        }
        // Ensure PWM direction matches error direction
        if (Math.sign(output) !== Math.sign(error)) {
            output = Math.sign(error) * PID.min_pwm;
        }
    }

    // Final output limiting
    output = Math.min(Math.max(output, -maxPwm), maxPwm);

    // Stop condition
    if (Math.abs(error) < PID.stop_margin) {
        output = 0;
    }

    PID.prev_error = error;
    PID.prev_time = current_time;

    console.log(`Error: ${(error * 180 / Math.PI).toFixed(2)}°, PWM: ${output.toFixed(2)}, I: ${PID.integral.toFixed(2)}, D: ${derivative.toFixed(2)}`);

    return {
        pwm: Math.round(output),
        error: error
    };
}

function sendUDPCommand(command) {
    if (!deviceState.address || !deviceState.hasSetpoint) {
        console.log('Cannot send command: Device not ready or no setpoint received');
        return;
    }

    let ipAddress = deviceState.address;
    if (ipAddress.startsWith('::ffff:')) {
        ipAddress = ipAddress.substr(7);
    }

    try {
        // Send command directly without encryption
        const message = JSON.stringify(command);
        udpSocket.send(
            message,
            deviceState.port,
            ipAddress,
            (err) => {
                if (err) {
                    console.error('UDP send error:', err);
                } else {
                    console.log(`UDP command sent to ${ipAddress}:${deviceState.port}: ${command}`);
                }
            }
        );
    } catch (error) {
        console.error('Error sending UDP command:', error);
    }
}

// Store connected web clients
const webClients = new Set();

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const clientType = req.headers.origin ? 'web' : 'device';
    let clientAddress = req.socket.remoteAddress;
    
    if (clientAddress.startsWith('::ffff:')) {
        clientAddress = clientAddress.substr(7);
    }
    
    console.log(`New ${clientType} client connected from ${clientAddress}`);

    if (clientType === 'web') {
        webClients.add(ws);
    }

    ws.on('message', (message) => {
        if (clientType === 'web') {
            try {
                // Removed decryption
                const setpoint = JSON.parse(message);
                if (!isNaN(setpoint)) {
                    console.log(`Received setpoint: ${setpoint}°`);
                    PID.target_angle = setpoint * Math.PI / 180;
                    deviceState.hasSetpoint = true;
                    
                    // Reset PID state for new setpoint
                    PID.integral = 0;
                    PID.integral_window = [];
                    PID.prev_error = 0;
                    PID.prev_time = Date.now();

                    if (deviceState.authenticated) {
                        const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                        sendUDPCommand(pidOutput.pwm);
                    }
                }
            } catch (error) {
                console.error('Error processing web message:', error);
            }
        } else {
            if (!deviceState.authenticated) {
                try {
                    const authData = JSON.parse(message);
                    if (authData.name === "Sean" && authData.password === "bayar10rb") {
                        deviceState.authenticated = true;
                        deviceState.address = clientAddress;
                        ws.send("Authentication successful");
                        console.log(`Controller authenticated: ${clientAddress}`);
                    } else {
                        ws.close();
                    }
                } catch (error) {
                    console.error('Authentication error:', error);
                    ws.close();
                }
            } else {
                try {
                    const currentAngle = parseFloat(message);
                    if (!isNaN(currentAngle)) {
                        PID.current_angle = currentAngle;
                        console.log(`Position feedback: ${(currentAngle * 180 / Math.PI).toFixed(2)}°`);
                        
                        // Broadcast position to all web clients
                        webClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(String(currentAngle));
                            }
                        });
                        
                        if (deviceState.hasSetpoint) {
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                            sendUDPCommand(pidOutput.pwm);
                        }
                    }
                } catch (error) {
                    console.error('Error processing device feedback:', error);
                }
            }
        }
    });

    ws.on('close', () => {
        if (clientType === 'device') {
            deviceState.authenticated = false;
            deviceState.hasSetpoint = false;
            PID.target_angle = null;
            console.log(`Controller disconnected: ${clientAddress}`);
        } else {
            webClients.delete(ws);
            console.log(`Web client disconnected: ${clientAddress}`);
        }
    });
});

// Start server
const WS_PORT = 8765;
server.listen(WS_PORT, () => {
    console.log(`Server running on port ${WS_PORT}`);
    console.log(`WebSocket server: ws://localhost:${WS_PORT}`);
});