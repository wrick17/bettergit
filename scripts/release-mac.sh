#!/usr/bin/env bash
# Builds the arm64 DMG, signs it with Developer ID, notarizes and staples both
# the app and the DMG, then verifies the result.
# Usage: scripts/release-mac.sh [version]   (defaults to package.json version)
#
# Signing: CSC_LINK + CSC_KEY_PASSWORD (CI), otherwise the login keychain identity.
# Notarization: APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER.
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:-$(bun -p 'require("./package.json").version')}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$version' is not a semver version (expected tag vX.Y.Z)" >&2
  exit 1
fi
: "${APPLE_API_KEY:?set APPLE_API_KEY to the path of the App Store Connect .p8 key}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
[[ -f "$APPLE_API_KEY" ]] || { echo "error: $APPLE_API_KEY is not a file" >&2; exit 1; }

app="dist/mac-arm64/BetterGit.app"
dmg="dist/BetterGit-$version-arm64.dmg"
rm -rf dist
bun run build
# electron-builder signs, notarizes and staples the .app; forceCodeSigning fails the build without an identity.
bunx electron-builder --mac dmg --arm64 --publish never \
  -c.forceCodeSigning=true -c.extraMetadata.version="$version"

# electron-builder only signs the DMG, so notarize and staple it here.
result="$(xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" --wait --output-format json)"
echo "$result"
if [[ "$(bun -p 'JSON.parse(process.argv[1]).status' "$result")" != "Accepted" ]]; then
  id="$(bun -p 'JSON.parse(process.argv[1]).id' "$result")"
  xcrun notarytool log "$id" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" || true
  exit 1
fi
xcrun stapler staple "$dmg"

codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose "$app"
spctl --assess --type open --context context:primary-signature --verbose "$dmg"
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
echo "Release ready: $dmg"
