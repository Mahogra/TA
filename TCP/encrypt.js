// encrypt.js

// Constants (using the same values as in your Python code)
const e = 4098899;
const d = 4190699;
const n = 4519001;
const phi_n = 4514100;
const p = 3671;
const q = 1231;

// Encryption function
function enkripsi(message) {
    const messageEncode = Array.from(message).map(ch => ch.charCodeAt(0));
    const ciphertext = messageEncode.map(ch => powerMod(ch, e, n));
    return ciphertext;
}

// Decryption function
function dekripsi(ciphertext) {
    const messageEncode = ciphertext.map(ch => powerMod(ch, d, n));
    const message = messageEncode.map(ch => String.fromCharCode(ch)).join('');
    return message;
}

// Helper function for modular exponentiation
function powerMod(base, exponent, modulus) {
    if (modulus === 1) return 0;
    let result = 1;
    base = base % modulus;
    while (exponent > 0) {
        if (exponent % 2 === 1) {
            result = (result * base) % modulus;
        }
        base = (base * base) % modulus;
        exponent = Math.floor(exponent / 2);
    }
    return result;
}

module.exports = {
    enkripsi,
    dekripsi
};