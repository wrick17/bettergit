#!/usr/bin/env bash
# Builds the arm64 DMG for the package.json version.
# Usage: scripts/release-mac.sh [expected-version]   (fails if it differs from package.json)
#
# Signed release: set all of CSC_LINK (.p12 path or base64), CSC_KEY_PASSWORD,
# APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID and APPLE_API_ISSUER. The app is
# signed with Developer ID, and the app and DMG are notarized, stapled and verified.
# Unsigned release: set none of them. The app is ad-hoc signed and not notarized.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(bun -p 'require("./package.json").version')"
if [[ $# -gt 0 && "$1" != "$version" ]]; then
  echo "error: expected version '$1' but package.json has '$version'. Bump package.json and commit before tagging." >&2
  exit 1
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: package.json version '$version' is not semver" >&2
  exit 1
fi

signing_vars=(CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER)
set_vars=()
for var in "${signing_vars[@]}"; do
  if [[ -n "${!var:-}" ]]; then set_vars+=("$var"); fi
done

app="dist/mac-arm64/BetterGit.app"
dmg="dist/BetterGit-$version-arm64.dmg"

if [[ ${#set_vars[@]} -eq 0 ]]; then
  echo "warning: no signing variables set, building an UNSIGNED (ad-hoc) release" >&2
  unset "${signing_vars[@]}"
  rm -rf dist
  bun run build
  # Apple Silicon only runs signed code, so sign ad-hoc. Hardened runtime would make
  # library validation reject Electron's frameworks under an ad-hoc signature.
  CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --mac dmg --arm64 --publish never \
    -c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false -c.dmg.sign=false
  codesign --verify --deep --strict --verbose=2 "$app"
  echo "Unsigned release ready: $dmg"
  exit 0
fi

if [[ ${#set_vars[@]} -ne ${#signing_vars[@]} ]]; then
  echo "error: partial signing config. Set all or none of: ${signing_vars[*]}" >&2
  echo "error: currently set: ${set_vars[*]}" >&2
  exit 1
fi
[[ -f "$APPLE_API_KEY" ]] || { echo "error: APPLE_API_KEY is not a file" >&2; exit 1; }

rm -rf dist
bun run build
# electron-builder signs, notarizes and staples the .app; forceCodeSigning fails the build without an identity.
bunx electron-builder --mac dmg --arm64 --publish never -c.forceCodeSigning=true

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
echo "Signed release ready: $dmg"
