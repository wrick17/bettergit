#!/usr/bin/env bash
# Bundles the private key from signing-csr.sh with the Developer ID certificate
# into a password-protected .p12, optionally imports it into the login keychain,
# and prints the commands that store the release secrets in GitHub.
# Usage: scripts/signing-p12.sh <developer-id.cer> [--import]
set -euo pipefail

cer="${1:?usage: scripts/signing-p12.sh <developer-id.cer> [--import]}"
dir="${SIGNING_DIR:-$HOME/.bettergit-signing}"
key="$dir/developer-id.key"
pem="$dir/developer-id.pem"
ca="$dir/DeveloperIDG2CA.pem"
p12="$dir/developer-id.p12"
password_file="$dir/p12-password.txt"
# SHA-256 of https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
ca_sha256="F1:6C:D3:C5:4C:7F:83:CE:A4:BF:1A:3E:6A:08:19:C8:AA:A8:E4:A1:52:8F:D1:44:71:5F:35:06:43:D2:DF:3A"

[[ -f "$key" ]] || { echo "error: $key not found. Run scripts/signing-csr.sh first." >&2; exit 1; }
umask 077

# Apple sends DER; accept PEM too.
openssl x509 -inform DER -in "$cer" -out "$pem" 2>/dev/null || openssl x509 -in "$cer" -out "$pem"
if [[ "$(openssl x509 -in "$pem" -noout -pubkey)" != "$(openssl pkey -in "$key" -pubout)" ]]; then
  echo "error: $cer was not issued for $key. Was the CSR from this machine uploaded?" >&2
  exit 1
fi
openssl x509 -in "$pem" -noout -subject

# Include the Developer ID G2 intermediate so the chain is complete in any keychain.
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer | openssl x509 -inform DER -out "$ca"
fingerprint="$(openssl x509 -in "$ca" -noout -fingerprint -sha256)"
if [[ "${fingerprint#*=}" != "$ca_sha256" ]]; then
  echo "error: downloaded Developer ID G2 CA has an unexpected fingerprint" >&2
  exit 1
fi

[[ -s "$password_file" ]] || printf '%s' "$(openssl rand -base64 24)" > "$password_file"
# macOS `security import` only reads PKCS#12 files that use 3DES and a SHA-1 MAC.
# OpenSSL 3 defaults to AES and SHA-256; LibreSSL already uses 3DES and SHA-1.
legacy=(-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES)
[[ "$(openssl version)" == OpenSSL\ 3* ]] && legacy+=(-macalg sha1)
openssl pkcs12 -export "${legacy[@]}" -name "BetterGit Developer ID" \
  -inkey "$key" -in "$pem" -certfile "$ca" -out "$p12" -passout "file:$password_file"
chmod 600 "$pem" "$ca" "$p12" "$password_file"
echo "Created $p12 (password in $password_file)"

if [[ "${2:-}" == "--import" ]]; then
  # shortcut: the password is briefly visible to local `ps`, fine on a single-user Mac.
  security import "$p12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P "$(cat "$password_file")" -T /usr/bin/codesign -T /usr/bin/productbuild
  security find-identity -v -p codesigning | grep "Developer ID Application" || true
fi

cat <<EOF

Store the release secrets in GitHub (values are read from files or prompts, never echoed):
  base64 -i "$p12" | gh secret set CSC_LINK --repo wrick17/bettergit
  gh secret set CSC_KEY_PASSWORD --repo wrick17/bettergit < "$password_file"
  gh secret set APPLE_API_KEY_P8 --repo wrick17/bettergit < /path/to/AuthKey_KEYID.p8
  gh secret set APPLE_API_KEY_ID --repo wrick17/bettergit
  gh secret set APPLE_API_ISSUER --repo wrick17/bettergit
EOF
