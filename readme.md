sudo certbot certonly --webroot -w /var/www/html \
    --server https://acme.zerossl.com/v2/DV90 \
    --eab-kid "sDpCWC5VY7mt876vbCmZ_g" \
    --eab-hmac-key "dNstI0B4C7VQRxaz8nK5rqtrDbm32IvPtjb8CblKmM-vGK7vJhK_yRjsHjDFSRCNIcbZdRriBA1AqipMmTDQJw" \
    -d draft.altoev.com
