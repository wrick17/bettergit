#!/usr/bin/env bash
# Creates the private key and certificate signing request (CSR) for a
# Developer ID Application certificate. The key never leaves this machine.
set -euo pipefail

dir="${SIGNING_DIR:-$HOME/.bettergit-signing}"
key="$dir/developer-id.key"
csr="$dir/developer-id.certSigningRequest"

if [[ -e "$key" ]]; then
  echo "error: $key already exists. Move it away or set SIGNING_DIR to start over." >&2
  exit 1
fi

read -rp "Your name (certificate common name): " name
read -rp "Your email address: " email
# openssl -subj uses / and = as separators, so reject them instead of escaping.
for value in "$name" "$email"; do
  if [[ -z "$value" || "$value" == */* || "$value" == *=* || "$value" == *\\* ]]; then
    echo "error: name and email must be non-empty and must not contain / = or \\" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$dir"
chmod 700 "$dir"
openssl req -new -newkey rsa:2048 -nodes -keyout "$key" -out "$csr" \
  -subj "/emailAddress=$email/CN=$name" 2>/dev/null
chmod 600 "$key" "$csr"

echo "Private key: $key (keep it private, do not send it)"
echo "CSR:         $csr"
echo "Next: send the CSR to the Account Holder. When they send back the .cer, run:"
echo "  scripts/signing-p12.sh /path/to/developerID_application.cer --import"
