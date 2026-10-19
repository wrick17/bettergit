# Releasing BetterGit for macOS

A pushed `v*` tag builds an arm64 DMG on GitHub Actions. The workflow signs it with a Developer ID Application certificate, notarizes and staples it, and attaches it to the GitHub Release for that tag.

Setup happens once and involves two people. You hold the private key. A teammate who is the Account Holder of the Apple Developer team issues the certificate and the API key. The teammate never shares their Apple password.

## A. Create the key and the CSR (you)

1. Run the CSR script and enter your name and email when it asks:

   ```sh
   scripts/signing-csr.sh
   ```

   It writes `developer-id.key` and `developer-id.certSigningRequest` to `~/.bettergit-signing` (override with `SIGNING_DIR`). Both files are `chmod 600`.
2. Send `developer-id.certSigningRequest` to the teammate. Do not send `developer-id.key`.

## B. Issue the certificate and the API key (teammate)

Only the Account Holder can create a Developer ID certificate.

1. Create the certificate:
   1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources) and click **Certificates**.
   2. Click **+**. Under **Software**, select **Developer ID**, then click **Continue**.
   3. Select **Developer ID Application**. If the page asks for a Sub-CA, select **G2 Sub-CA**.
   4. Upload the `.certSigningRequest` file, click **Continue**, then click **Download**.
2. If the team has never used the App Store Connect API, open [App Store Connect](https://appstoreconnect.apple.com) and go to **Users and Access** > **Integrations** > **Request Access**. Apple reviews the request.
3. Create the API key:
   1. In **Users and Access** > **Integrations** > **App Store Connect API**, click **Team Keys**.
   2. Click **Generate API Key** (or **+**). Name it `BetterGit notarization` and set **Access** to **Developer**.
   3. Click **Generate**, then download the `AuthKey_<KEYID>.p8` file. Apple allows one download only.
4. Send back these four items over a private channel:
   - the `.cer` file
   - the `.p8` file
   - the **Key ID** from the key list
   - the **Issuer ID** shown above the key list

Apple does not document the minimum role for notarization. Developer works for most teams. If `notarytool` returns `401` or "unauthorized", revoke the key and generate a new one with **App Manager** access.

## C. Configure GitHub and cut a release (you)

1. Bundle the certificate with your key. The `--import` flag also adds the identity to your login keychain for local signing:

   ```sh
   scripts/signing-p12.sh ~/Downloads/developerID_application.cer --import
   ```

   The script checks that the certificate matches your key, adds Apple's Developer ID G2 intermediate, and writes `developer-id.p12` plus a random password in `p12-password.txt`.
2. Run the `gh secret set` commands the script prints. They read values from files or prompts, so nothing lands in shell history. The workflow uses these secrets:

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | base64 of `developer-id.p12` |
   | `CSC_KEY_PASSWORD` | contents of `p12-password.txt` |
   | `APPLE_API_KEY_P8` | contents of `AuthKey_<KEYID>.p8` |
   | `APPLE_API_KEY_ID` | Key ID |
   | `APPLE_API_ISSUER` | Issuer ID |

3. Move the `.cer` and `.p8` into `~/.bettergit-signing` and delete any copies in Downloads or chat.
4. Tag and push:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

   The tag sets the app version, so `v0.2.0` ships as `0.2.0` and `package.json` needs no bump. Tags must be semver (`vX.Y.Z` or `vX.Y.Z-beta.1`). The **Release** workflow attaches `BetterGit-0.2.0-arm64.dmg` to the `v0.2.0` release. It creates the release if it does not exist.

### Release from your Mac

After step 1 imports the identity, run:

```sh
APPLE_API_KEY=~/.bettergit-signing/AuthKey_KEYID.p8 \
APPLE_API_KEY_ID=KEYID APPLE_API_ISSUER=ISSUER-UUID \
bun run release:mac 0.2.0
```

The DMG lands in `dist/`. `bun run dist` builds an unsigned DMG for testing when no identity or API key is present.

## Troubleshooting

- **The build fails with "skipped macOS application code signing".** electron-builder found no Developer ID identity, and `release-mac.sh` refuses to ship unsigned. Run `security find-identity -v -p codesigning`. On CI, check that `CSC_LINK` holds the base64 `.p12` and that `CSC_KEY_PASSWORD` matches it.
- **`security import` reports "MAC verification failed".** Another tool made the `.p12` with OpenSSL 3 defaults. Rebuild it with `scripts/signing-p12.sh`, which uses the 3DES and SHA-1 format macOS accepts.
- **Notarization status is `Invalid`.** `release-mac.sh` prints the notary log. It usually names an unsigned binary or a missing hardened runtime flag.
- **The DMG needs a rebuild for the same tag.** Re-run the workflow. It replaces the DMG on the existing release.
