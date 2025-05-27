const WebSocket = require('ws');
const { enkripsi, dekripsi } = require('./encrypt.js');  // Import dekripsi function as well
const http = require('http');
const fs = require('fs');
const path = require('path');

const authenticatedClients = new Map();
const webClients = new Set();

// PID Controller Parameters
const PID = {
    Kp: 1.7,
    Ki: 0.03,
    Kd: 0.17,
    min_pwm: 10,
    max_pwm: 10,
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
    const now = Date.now();
    const dt = (now - PID.prev_time) / 1000; // Convert to seconds
   
    const error = targetAngle - currentAngle;
   
    // Calculate proportional term
    const proportional = PID.Kp * error;
   
    // Calculate integral term with anti-windup
    PID.integral += error * dt;
    const integral = PID.Ki * PID.integral;
   
    // Calculate derivative term
    const derivative = PID.Kd * (error - PID.prev_error) / dt;
   
    // Calculate total output
    let output = proportional + integral + derivative;
   
    // Apply PWM limits
    output = Math.min(Math.max(output, -PID.max_pwm), PID.max_pwm);
   
    // Save current error and time for next iteration
    PID.prev_error = error;
    PID.prev_time = now;
   
    // Check if we're close enough to target
    const atTarget = Math.abs(error) < PID.stop_margin;
   
    // Apply minimum PWM threshold but maintain direction
    if (!atTarget && Math.abs(output) < PID.min_pwm) {
        output = Math.sign(output) * PID.min_pwm;
    }
   
    // If we're at target, set PWM to 0 but don't stop sending signals
    if (atTarget) {
        output = 0;
    }
   
    return {
        pwm: Math.round(output),
        error: error,
        atTarget: atTarget,
        dt: dt
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

                        // Reset PID controller state when setting a new setpoint
                        PID.integral = 0;
                        PID.prev_error = 0;
                        PID.prev_time = Date.now();
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
                        // Check if the message is a plain text response to reset command
                        if (message.toString() === "Position Reset") {
                            console.log("Position reset confirmed by controller");
                            return; // Exit the function instead of using continue
                        }
                       
                        // Decrypt the position feedback from the controller
                        const decryptedMessage = dekripsi(JSON.parse(message));
                        const currentAngle = parseFloat(decryptedMessage);
                       
                        if (!isNaN(currentAngle)) {
                            PID.current_angle = currentAngle;
                           
                            // Calculate PID output regardless of whether we've reached target
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                           
                            // Print the dt value alongside the feedback data
                            console.log(`Received position feedback: ${currentAngle * 180 / Math.PI}°, dt: ${pidOutput.dt.toFixed(3)}s`);
                           
                            // Broadcast position to all web clients
                            webClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(String(currentAngle));
                                }
                            });
                           
                            // Always send PWM command, even if we've reached the target (will be 0 if at target)
                            const pwmMessage = JSON.stringify(pidOutput.pwm);
                            const encryptedMessage = JSON.stringify(enkripsi(pwmMessage));
                            ws.send(encryptedMessage);
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
