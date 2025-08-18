@ECHO OFF

set DIR=%~dp0
set APP_BASE_NAME=%~n0
set APP_HOME=%DIR%

set DEFAULT_JVM_OPTS=

if exist "%JAVA_HOME%\bin\java.exe" goto init

echo ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
exit /b 1

:init
"%JAVA_HOME%\bin\java" %DEFAULT_JVM_OPTS% -Dorg.gradle.appname=%APP_BASE_NAME% -classpath "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
