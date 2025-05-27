const WebSocket = require('ws');
const { enkripsi } = require('./encrypt.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

const authenticatedClients = new Map();
const webClients = new Set();

// PID Controller Parameters
const PID = {
    Kp: 1.7,
    Ki: 0.03,
    Kd: 0.5,
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

const wss = new WebSocket.Server({ server });

function calculatePID(targetAngle, currentAngle) {
    const error = targetAngle - currentAngle;

    let pwm = Math.abs(error) * PID.Kp;
    pwm = Math.min(Math.max(pwm, PID.min_pwm), PID.max_pwm);
    pwm *= Math.sign(error); // Memastikan PWM memiliki arah sesuai error

    return {
        pwm: Math.round(pwm),
       
        error: error
    };
}


const serverHandler = async (ws, req) => {
    const clientId = req.socket.remoteAddress;
    const clientType = req.headers.origin ? 'web' : 'device';
    console.log(`New ${clientType} client connected from ${clientId}`);

    if (clientType === 'web') {
        webClients.add(ws);
    }

    try {
        ws.on('message', async (message) => {
            if (clientType === 'web') {
                try {
                    const setpoint = parseFloat(message.toString());
                    if (!isNaN(setpoint)) {
                        console.log(`Received new setpoint: ${setpoint}°`);
                        
                        const resetMessage = JSON.stringify(enkripsi("RESET"));
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client.clientId)) {
                                client.send(resetMessage);
                            }
                        });

                        await new Promise(resolve => setTimeout(resolve, 500));

                        PID.target_angle = setpoint * Math.PI / 180;
                        const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                        
                        const pwmMessage = JSON.stringify(pidOutput.pwm);
                        const encryptedMessage = JSON.stringify(enkripsi(pwmMessage));
                        
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
                if (!authenticatedClients.has(clientId)) {
                    try {
                        const authData = JSON.parse(message);
                        if (authData.name === "Sean" && authData.password === "bayar10rb") {
                            authenticatedClients.set(clientId, true);
                            ws.clientId = clientId;
                            ws.send("Selamat datang! Anda terautentikasi.");
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
                            console.log(`Received position feedback: ${currentAngle * 180 / Math.PI}°`);
                            
                            // Broadcast position to all web clients
                            webClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(String(currentAngle));
                                }
                            });
                            
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                            
                            if (!pidOutput.atTarget) {
                                const pwmMessage = JSON.stringify(pidOutput.pwm);
                                const encryptedMessage = JSON.stringify(enkripsi(pwmMessage));
                                ws.send(encryptedMessage);
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
            } else {
                webClients.delete(ws);
            }
            console.log(`${clientType} client disconnected: ${clientId}`);
        });

    } catch (error) {
        console.error(`Connection Error:`, error);
        if (clientType === 'device') {
            authenticatedClients.delete(clientId);
        } else {
            webClients.delete(ws);
        }
    }
};

const PORT = 8765;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

wss.on('connection', serverHandler);