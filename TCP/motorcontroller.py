import asyncio
import websockets
import json
import time
import numpy as np
import pandas as pd
from labjack_unified.devices import LabJackT7
from encrypt import dekripsi

class MotorController:
    def __init__(self):
        self.anglecurr_total = 0
        self.ppr = 8 * 310  # Pulses per rotation
        self.lj = LabJackT7()
        self.setup_labjack()

    def setup_labjack(self):
        self.lj.set_pwm(dirport1='DAC')
        self.lj.set_quadrature()

    def reset_position(self):
        self.anglecurr_total = 0
        initial_encoder_count = self.lj.get_counter()
        self.lj.reset_counter(initial_encoder_count)

    def run_motor(self, angle, target_angle):
        pwm_value = np.clip(angle, -100, 100)
        initial_encoder_count = self.lj.get_counter()

        self.lj.set_dutycycle(value1=pwm_value)
        time.sleep(0.2)  # Durasi gerak motor lebih lama
        
        encoder_count = self.lj.get_counter() - initial_encoder_count
        current_angle = (2 * np.pi / self.ppr) * encoder_count
        
        self.lj.set_dutycycle(value1=0)
        self.anglecurr_total += current_angle

        return self.anglecurr_total

    async def client_handler(self):
        uri = "ws://10.96.1.61:8765"
        async with websockets.connect(uri) as websocket:
            auth_data = {"name": "Sean", "password": "bayar10rb"}
            await websocket.send(json.dumps(auth_data))

            response = await websocket.recv()
            print(f"Received from server: {response}")

            while True:
                try:
                    message = await websocket.recv()
                    decrypted_message = dekripsi(eval(message))
                    print(f"Decrypted PWM command: {decrypted_message}")

                    if decrypted_message == "RESET":
                        self.reset_position()
                        await websocket.send("Position Reset")
                        continue

                    angle = int(decrypted_message)
                    current_position = self.run_motor(angle, 0)
                    
                    await websocket.send(str(current_position))
                    print(f"Sent position feedback: {current_position}")

                except websockets.exceptions.ConnectionClosed:
                    break

    def __del__(self):
        self.lj.close()

async def main():
    motor_controller = MotorController()
    await motor_controller.client_handler()

if __name__ == "__main__":
    asyncio.run(main())