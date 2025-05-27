const WebSocket = require('ws');
const { enkripsi } = require('./encrypt.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Dictionary to store authentication status for device clients
const authenticatedClients = new Map();

// PID Controller Parameters
const PID = {
    Kp: 0.5,
    Ki: 0.01,
    Kd: 0.1,
    min_pwm: 10,
    max_pwm: 50,
    stop_margin: 0.1,
    integral: 0,
    prev_error: 0,
    prev_time: Date.now(),
    target_angle: 0,
    current_angle: 0
};

// Create HTTP server
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

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// PID Control Function
function calculatePID(targetAngle, currentAngle) {
    const error = targetAngle - currentAngle;

    // Linear PWM output
    let pwm = Math.abs(error) * PID.Kp;
    pwm = Math.min(Math.max(pwm, PID.min_pwm), PID.max_pwm);
    pwm *= Math.sign(error);

    return {
        pwm: Math.round(pwm),
        error: error,
        atTarget: Math.abs(error) <= PID.stop_margin
    };
}

// WebSocket server handler
const serverHandler = async (ws, req) => {
    const clientId = req.socket.remoteAddress;
    const clientType = req.headers.origin ? 'web' : 'device';
    console.log(`New ${clientType} client connected from ${clientId}`);

    try {
        ws.on('message', async (message) => {
            if (clientType === 'web') {
                // Handle web client messages (setpoints)
                try {
                    const setpoint = parseFloat(message.toString());
                    if (!isNaN(setpoint)) {
                        console.log(`Received new setpoint: ${setpoint}°`);
                        
                        // Reset posisi sebelum bergerak
                        const resetMessage = JSON.stringify(enkripsi("RESET"));
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client.clientId)) {
                                client.send(resetMessage);
                            }
                        });

                        // Tunggu konfirmasi reset
                        await new Promise(resolve => setTimeout(resolve, 500));

                        // Convert degrees to radians
                        PID.target_angle = setpoint * Math.PI / 180;
                        
                        // Calculate initial PWM
                        const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                        
                        // Encrypt PWM value before sending
                        const pwmMessage = JSON.stringify(pidOutput.pwm);
                        const encryptedMessage = JSON.stringify(enkripsi(pwmMessage));
                        console.log('Sending encrypted PWM:', encryptedMessage);
                        
                        // Send to authenticated device clients
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client.clientId)) {
                                client.send(encryptedMessage);
                            }
                        });
                    }
                } catch (error) {
                    console.error('Error processing setpoint:', error);
                }
            } else {
                // Handle device client messages
                if (!authenticatedClients.has(clientId)) {
                    // Handle authentication
                    try {
                        const authData = JSON.parse(message);
                        if (authData.name === "Sean" && authData.password === "bayar10rb") {
                            authenticatedClients.set(clientId, true);
                            ws.clientId = clientId;
                            console.log(`Device authenticated successfully: ${clientId}`);
                            ws.send("Selamat datang! Anda terautentikasi.");
                        } else {
                            console.log(`Authentication failed from device: ${clientId}`);
                            ws.close();
                        }
                    } catch (error) {
                        console.error('Authentication error:', error);
                        ws.close();
                    }
                } else {
                    // Handle position feedback from device
                    try {
                        const currentAngle = parseFloat(message);
                        if (!isNaN(currentAngle)) {
                            PID.current_angle = currentAngle;
                            console.log(`Received position feedback: ${currentAngle * 180 / Math.PI}°`);
                            
                            // Calculate new PWM based on current position
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                            
                            if (!pidOutput.atTarget) {
                                const pwmMessage = JSON.stringify(pidOutput.pwm);
                                const encryptedMessage = JSON.stringify(enkripsi(pwmMessage));
                                ws.send(encryptedMessage);
                            } else {
                                console.log('Target position reached!');
                            }
                        }
                    } catch (error) {
                        console.error('Error processing position feedback:', error);
                    }
                }
            }
        });

        ws.on('close', () => {
            if (clientType === 'device') {
                authenticatedClients.delete(clientId);
                console.log(`Device client disconnected: ${clientId}`);
            } else {
                console.log(`Web client disconnected: ${clientId}`);
            }
        });

    } catch (error) {
        console.error(`Connection Error:`, error);
        if (clientType === 'device') {
            authenticatedClients.delete(clientId);
        }
    }
};

// Start server
const PORT = 8765;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

wss.on('connection', serverHandler);