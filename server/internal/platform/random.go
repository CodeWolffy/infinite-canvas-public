package platform

import (
	crand "crypto/rand"
	"math/big"
)

const alphanumericCharset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

func randomAlphanumeric(length int) (string, error) {
	if length <= 0 {
		return "", nil
	}
	b := make([]byte, length)
	maxI := big.NewInt(int64(len(alphanumericCharset)))
	for i := range b {
		n, err := crand.Int(crand.Reader, maxI)
		if err != nil {
			return "", err
		}
		b[i] = alphanumericCharset[n.Int64()]
	}
	return string(b), nil
}
