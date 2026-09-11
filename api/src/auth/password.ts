import argon2 from "argon2";

// 预置的固定合法 argon2id 占位 hash，用于用户不存在时拉平验证时延
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$w2N8pM5F2YJqXGgR3B4Pqw$fV6p6n9HwL8Q4mX1t0jK7lZ8x3v2y1z0aB4cD6eF8gH";

export function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}
