import random
import math
# def is_prime(number):
#     if number < 2 :
#         return False
#     for i in range(2, number // 2 + 1) :
#         if number % i == 0 :
#             return False
        
#     return True

# def generate_prime(min_value, max_value):
#     prime =  random.randint(min_value, max_value)
#     while not is_prime(prime):
#         prime = random.randint(min_value, max_value)

#     return prime

# def mod_inverse(e, phi):
#     for d in range(3, phi):
#         if (d * e) % phi == 1:
#             return d
#     raise ValueError("mod_inverse does not exist")

# p, q = generate_prime(1000, 5000), generate_prime(1000, 5000)

# while p == q:
#     q = generate_prime(1000, 5000)

# n = p * q
# phi_n = (p-1) * (q-1)

# e = random.randint(3, phi_n - 1)
# while math.gcd(e, phi_n) != 1:
#     e = random.randint(3, phi_n - 1)

# d = mod_inverse(e, phi_n)
def enkripsi(message): 
    message_encode = [ord(ch) for ch in message]
    ciphertext = [pow(ch, e, n) for ch in message_encode]
    return ciphertext

def dekripsi(ciphertext):
    message_encode = [pow(ch,d, n ) for ch in ciphertext]
    message = "".join(chr(ch) for ch in message_encode)
    return message
e= 4098899
d = 4190699
n = 4519001
phi_n = 4514100
p = 3671
q = 1231
# print("Public key is ", e)
# print("private key is", d)
# print("n:", n)
# print("phi of n", phi_n)
# print("p:", p)
# print("q:", q)
# message = input("Masukkan angka: ")
# ciphertext = enkripsi(message)
# print(ciphertext)
# message_new = dekripsi(ciphertext)
# print(message_new)
