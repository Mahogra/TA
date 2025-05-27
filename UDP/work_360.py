import asyncio
import websockets
import json
import time
import numpy as np
from labjack_unified.devices import LabJackT7
from encrypt import enkripsi, dekripsi

class MotorController:
    def __init__(self):
        # Basic configuration
        self.anglecurr_total = 0
        self.ppr = 8 * 310  # Pulses per rotation
        self.lj = LabJackT7()
        
        # Network configuration
        self.server_ip = "10.96.1.51"
        self.udp_port = 8766
        self.ws_port = 8765
        
        # Controller state
        self.running = True
        
        # Initialize hardware
        self.setup_labjack()

    def setup_labjack(self):
        self.lj.set_pwm(dirport1='DAC')
        self.lj.set_quadrature()

    def reset_position(self):
        self.anglecurr_total = 0
        initial_encoder_count = self.lj.get_counter()
        self.lj.reset_counter(initial_encoder_count)
        return "Position Reset"

    def run_motor(self, angle):
        try:
            # Clip PWM value to valid range
            pwm_value = np.clip(angle, -100, 100)
            initial_encoder_count = self.lj.get_counter()

            # Set motor PWM and wait
            self.lj.set_dutycycle(value1=pwm_value)
            time.sleep(0.2)  # Longer duration for motor movement
            
            # Calculate angle change
            encoder_count = self.lj.get_counter() - initial_encoder_count
            current_angle = (2 * np.pi / self.ppr) * encoder_count
            
            # Update total angle
            self.anglecurr_total += current_angle

            return self.anglecurr_total
            
        except Exception as e:
            print(f"Error in run_motor: {e}")
            self.lj.set_dutycycle(value1=0)
            return self.anglecurr_total

    async def setup_udp(self):
        try:
            self.udp_transport, _ = await asyncio.get_event_loop().create_datagram_endpoint(
                lambda: UDPClientProtocol(self),
                local_addr=('0.0.0.0', self.udp_port)
            )
            print(f"UDP listener started on port {self.udp_port}")
        except Exception as e:
            print(f"Error setting up UDP: {e}")
            self.running = False

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

                    while self.running:
                        #await websocket.send(enkripsi(self.anglecurr_total))
                        await websocket.send(str(self.anglecurr_total))
                        print(f"Position: {self.anglecurr_total * 180 / np.pi:.2f}°")
                        await asyncio.sleep(0.1)

            except websockets.exceptions.ConnectionClosed:
                print("WebSocket connection closed, reconnecting...")
                await asyncio.sleep(1)
            except Exception as e:
                print(f"WebSocket Error: {e}")
                await asyncio.sleep(1)

    async def run(self):
        try:
            await asyncio.gather(
                self.setup_udp(),
                self.handle_websocket_feedback()
            )
        except Exception as e:
            print(f"Error in main loop: {e}")
        finally:
            self.running = False
            self.lj.set_dutycycle(value1=0)

    def __del__(self):
        self.running = False
        self.lj.set_dutycycle(value1=0)
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
            message = data.decode()
            decrypted_message = dekripsi(eval(message))
            print(f"Received command: {decrypted_message}")

            if decrypted_message == "RESET":
                response = self.controller.reset_position()
            else:
                angle = int(decrypted_message)
                response = self.controller.run_motor(angle)

            print(f"Command executed: {response}")
            
        except Exception as e:
            print(f"Error processing command: {e}")

async def main():
    controller = MotorController()
    try:
        await controller.run()
    except KeyboardInterrupt:
        print("Shutting down...")
    finally:
        controller.__del__()

if __name__ == "__main__":
    asyncio.run(main())