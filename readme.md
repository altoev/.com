sudo certbot certonly --standalone --server https://acme.zerossl.com/v2/DV90 \
    --eab-kid "<YOUR_KEY_ID>" \
    --eab-hmac-key "<YOUR_HMAC_KEY>" \
    -d draft.altoev.com
