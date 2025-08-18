How to build the Android APK (Windows)

Prereqs:
- Android Studio Jellyfish or later
- Android SDK 34, Android Gradle Plugin 8.5+
- JDK 17

Steps:
1) Open folder android-app in Android Studio.
2) Let it sync Gradle. If asked, set JDK to 17.
3) Connect a device or start an emulator.
4) Run app or Build > Build APK(s) to get an APK under app/build/outputs/apk/.

Config file path on device:
- /data/data/com.ankitseal.dashboardautoreload/files/DashboardAutoReload/config.json

On first launch, use the floating Settings button to configure URL, SESSION, refresh, rolling window, etc. The app mirrors the Electron behaviors as closely as possible in WebView.
