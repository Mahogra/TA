import asyncio
import websockets
import json
import time
import numpy as np
from labjack_unified.devices import LabJackT7
# Removed the import for decryption

class MotorController:
    def __init__(self):
        # Controller configuration
        self.anglecurr_total = 0
        self.ppr = 8 * 310  # Pulses per rotation
        self.lj = LabJackT7()
        self.initial_encoder_count = 0  # Store initial encoder count
        
        # Network configuration
        self.server_ip = "10.250.25.253"
        self.udp_port = 8766
        self.ws_port = 8765
        
        # Control and safety parameters
        self.running = True
        self.last_command_time = time.time()
        self.command_timeout = 1.0
        
        # Initialize hardware
        self.setup_labjack()
        self.initial_encoder_count = self.lj.get_counter()  # Save initial position

    def setup_labjack(self):
        self.lj.set_pwm(dirport1='DAC')
        self.lj.set_quadrature()

    def reset_position(self):
        self.anglecurr_total = 0
        self.initial_encoder_count = self.lj.get_counter()
        self.lj.reset_counter(self.initial_encoder_count)
        return "Position Reset"

    def get_current_angle(self):
        # Calculate absolute angle based on initial position
        current_count = self.lj.get_counter()
        encoder_diff = current_count - self.initial_encoder_count
        return (2 * np.pi / self.ppr) * encoder_diff

    def update_position(self):
        # Update the current absolute position
        self.anglecurr_total = self.get_current_angle()
        return self.anglecurr_total

    def run_motor(self, angle):
        # Convert PWM command to duty cycle
        pwm_value = np.clip(angle, -100, 100)

        if angle == 0:
            self.lj.set_dutycycle(value1=0)  # Pastikan motor berhenti
            print("Motor stopped, shutting down program...")

            # Hentikan semua task asyncio
            self.running = False
            loop = asyncio.get_event_loop()
            for task in asyncio.all_tasks(loop):
                task.cancel()  # Hentikan semua task yang sedang berjalan

            return "Motor Stopped"

        else:
            self.lj.set_dutycycle(value1=pwm_value)

        time.sleep(0.1)
        
        return self.update_position()

    async def setup_udp(self):
        self.udp_transport, _ = await asyncio.get_event_loop().create_datagram_endpoint(
            lambda: UDPClientProtocol(self),
            local_addr=('0.0.0.0', self.udp_port)
        )
        print(f"UDP listener started on port {self.udp_port}")

    async def handle_websocket_feedback(self):
        while self.running:
            try:
                uri = f"ws://{self.server_ip}:{self.ws_port}"
                async with websockets.connect(uri) as websocket:
                    # Authentication
                    auth_data = {"name": "Sean", "password": "bayar10rb"}
                    await websocket.send(json.dumps(auth_data))
                    response = await websocket.recv()
                    print(f"WebSocket authentication: {response}")

                    # Feedback loop with continuous position updates
                    while self.running:
                        # Update position before sending feedback
                        current_angle = self.update_position()
                        await websocket.send(str(current_angle))
                        print(f"Sent position feedback: {current_angle * 180 / np.pi}°")
                        await asyncio.sleep(0.1)  # 10Hz feedback rate

            except websockets.exceptions.ConnectionClosed:
                print("WebSocket connection closed, stopping motor...")
                self.lj.set_dutycycle(value1=0)  # Hentikan motor jika koneksi putus
                await asyncio.sleep(1)
            except Exception as e:
                print(f"WebSocket Error: {e}")
                self.lj.set_dutycycle(value1=0)  # Hentikan motor jika terjadi error
                await asyncio.sleep(1)

    def safety_check(self):
        if time.time() - self.last_command_time > self.command_timeout:
            self.lj.set_dutycycle(value1=0)
            print("Safety timeout: Motor stopped")

    async def run(self):
        await self.setup_udp()
        await self.handle_websocket_feedback()

    def __del__(self):
        self.running = False
        print("Shutting down controller, stopping motor...")

        # Pastikan motor berhenti sebelum keluar
        self.lj.set_dutycycle(value1=0)

        # Tutup koneksi UDP jika ada
        if hasattr(self, 'udp_transport'):
            self.udp_transport.close()

        self.lj.close()

class UDPClientProtocol:
    def __init__(self, controller):
        self.controller = controller

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        try:
            # Receive data directly without decryption
            message = data.decode()
            command = json.loads(message)
            print(f"Received UDP command: {command}")

            self.controller.last_command_time = time.time()

            if command == "RESET":
                response = self.controller.reset_position()
            else:
                angle = int(command)
                response = self.controller.run_motor(angle)

            print(f"Command executed: {response}")
            
        except Exception as e:
            print(f"Error processing UDP command: {e}")
        finally:
            self.controller.safety_check()

async def main():
    controller = MotorController()
    try:
        await controller.run()
    except KeyboardInterrupt:
        print("Shutting down controller...")
    finally:
        controller.__del__()  # Panggil destructor untuk menghentikan motor dengan aman

if __name__ == "__main__":
    asyncio.run(main())