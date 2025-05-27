const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const authenticatedClients = new Map();
const webClients = new Set();

// PID Controller Parameters
const PID = {
    Kp: 10,
    Ki: 1,
    Kd: 7,
    min_pwm: 1,
    max_pwm: 50,
    stop_margin: 0.1,
    integral: 0,
    prev_error: 0,
    prev_time: Date.now(),
    target_angle: 0,
    current_angle: 0,
    last_dt: 0  // Tambahkan variabel untuk menyimpan delta time
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
    
    // Simpan delta time untuk logging
    PID.last_dt = dt;
    
    // Prevent very small dt to avoid numerical instability
    if (dt < 0.001) return { pwm: 0, error: 0, atTarget: false };
    
    const error = targetAngle - currentAngle;
    
    // Proportional term
    const P = PID.Kp * error;
    
    // Integral term with anti-windup protection
    PID.integral = Math.max(
        Math.min(PID.integral + error * dt, PID.max_pwm / PID.Ki),
        -PID.max_pwm / PID.Ki
    );
    const I = PID.Ki * PID.integral;
    
    // Derivative term with low-pass filter to reduce noise
    const derivative = (error - PID.prev_error) / dt;
    const D = PID.Kd * derivative;
    
    // Calculate total PID output
    let output = P + I + D;
    
    // Constrain output
    output = Math.min(Math.max(output, -PID.max_pwm), PID.max_pwm);
    
    // Check if we're close to target
    const atTarget = Math.abs(error) <= PID.stop_margin;
    
    // Modifikasi logika PWM untuk stabilitas
    if (atTarget) {
        // Jika sudah dekat target, kirim PWM minimal sesuai arah
        output = Math.sign(error) * PID.min_pwm;
    } else {
        // Pastikan PWM minimal diterapkan
        if (Math.abs(output) < PID.min_pwm) {
            output = Math.sign(output) * PID.min_pwm;
        }
    }
    
    // Update previous values
    PID.prev_error = error;
    PID.prev_time = now;
    
    return {
        pwm: Math.round(output),
        error: error,
        atTarget: atTarget
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
                        
                        // Reset PID state
                        PID.integral = 0;
                        PID.prev_error = 0;
                        PID.prev_time = Date.now();
                        
                        // Send reset message
                        const resetMessage = "RESET";
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client.clientId)) {
                                client.send(resetMessage);
                            }
                        });

                        // Short delay to ensure reset
                        await new Promise(resolve => setTimeout(resolve, 500));

                        // Convert setpoint to radians
                        PID.target_angle = setpoint * Math.PI / 180;
                        
                        // Calculate initial PWM
                        const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                        
                        // Send PWM
                        const pwmMessage = String(pidOutput.pwm);
                        
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client.clientId)) {
                                client.send(pwmMessage);
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
                            // Update current angle
                            PID.current_angle = currentAngle;
                            
                            // Log position feedback dengan delta time
                            console.log(`Position Feedback: ${(currentAngle * 180 / Math.PI).toFixed(2)}° | dt: ${PID.last_dt.toFixed(4)}s`);
                            
                            // Broadcast position to web clients
                            webClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(String(currentAngle));
                                }
                            });
                            
                            // Always calculate and send PID output
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                            
                            // Send PWM
                            ws.send(String(pidOutput.pwm));
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