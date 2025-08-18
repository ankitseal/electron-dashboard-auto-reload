Android WebView app for Dashboard Auto Reload

This module provides a minimal native Android app (Kotlin) that loads the configured dashboard URL, applies a SESSION cookie, supports keep-alive pings, periodic reload, a rolling time window, and a simple settings screen that reads/writes the same config.json used by the Electron app.

Build: Open this folder in Android Studio (Giraffe+). Use Gradle Wrapper to build and assemble a debug APK.

Note: Storing and managing cookies/sessions on Android uses CookieManager. For secure storage of user credentials, this demo writes to the same config.json as Electron; consider migrating to EncryptedSharedPreferences/Keystore.
