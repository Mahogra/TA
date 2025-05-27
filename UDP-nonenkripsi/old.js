const dgram = require('dgram');
const WebSocket = require('ws');
const http = require('http');
const { enkripsi } = require('./encrypt.js');
const fs = require('fs');
const path = require('path');

const udpSocket = dgram.createSocket('udp4');

// PID Controller Parameters
const PID = {
    Kp: 5,
    Ki: 0.6,
    Kd: 0.17,
    min_pwm: 5,
    max_pwm: 50,
    stop_margin: 0.017,
    integral: 0,
    prev_error: 0,
    prev_time: Date.now(),
    target_angle: null,
    current_angle: 0
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
    const dt = (current_time - PID.prev_time) / 1000;
    const error = targetAngle - currentAngle;

    // Don't stop when reaching target, let it stabilize naturally
    const maxIntegral = 10;
    if (Math.abs(error) > PID.stop_margin * 2) {
        PID.integral += error * dt;
        PID.integral = Math.max(Math.min(PID.integral, maxIntegral), -maxIntegral);
    } else {
        PID.integral = 0.98;
    }

    const derivative = dt > 0 ? (error - PID.prev_error) / dt : 0;
    let output = (PID.Kp * error) + (PID.Ki * PID.integral) + (PID.Kd * derivative);
    const minMaintainPwm = 3; // PWM minimum agar tidak mati total
    if (Math.abs(output) < minMaintainPwm) {
        output = Math.sign(output) * minMaintainPwm;
    }
    // Dynamic PWM scaling
    const errorMagnitude = Math.abs(error);
    const dynamicMaxPwm = errorMagnitude > 0.5 ? PID.max_pwm : PID.max_pwm * 0.6;
    output = Math.min(Math.max(output, -dynamicMaxPwm), dynamicMaxPwm);
    
    PID.prev_error = error;
    PID.prev_time = current_time;

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
        const encryptedMessage = JSON.stringify(enkripsi(JSON.stringify(command)));
        udpSocket.send(
            encryptedMessage,
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
                const setpoint = parseFloat(message);
                if (!isNaN(setpoint)) {
                    console.log(`Received setpoint: ${setpoint}°`);
                    PID.target_angle = setpoint * Math.PI / 180;
                    deviceState.hasSetpoint = true;
                    
                    PID.integral = 0;
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
                        console.log(`Position feedback: ${currentAngle * 180 / Math.PI}°`);
                        
                        // Broadcast position to all web clients
                        webClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(String(currentAngle));
                            }
                        });
                        
                        if (deviceState.hasSetpoint) {
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                            // Always send command to maintain position
                            sendUDPCommand(pidOutput.pwm || minMaintainPwm);
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