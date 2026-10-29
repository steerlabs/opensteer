plugins {
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.android.application)
}

/**
 * A tiny app the end-to-end suite operates through the Agent Phone. Every
 * interaction lands in a receipts table the suite reads over ADB, so a test
 * asserts the exact effect of each action rather than how the screen looks.
 */
android {
    namespace = "com.opensteer.agentphone.fixture"
    compileSdk = 36
    buildFeatures { compose = true }

    defaultConfig {
        applicationId = "com.opensteer.agentphone.fixture"
        minSdk = 30
        targetSdk = 36
        testInstrumentationRunner = "com.opensteer.agentphone.fixture.TextReceiptInstrumentation"
        versionCode = 1
        versionName = "1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
    }
}


dependencies {
    implementation(libs.activity)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.foundation)
    implementation(libs.compose.ui)
}
