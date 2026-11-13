plugins {
    kotlin("jvm")
    `java-library`
}
layout.buildDirectory = rootProject.layout.buildDirectory.dir("phone-connection-tests")
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../../mobile/modules/phone-connection/android/src/main/java")
        kotlin.include("**/core/**", "**/BrowserTransport.kt")
    }
    test { kotlin.srcDir("../../mobile/modules/phone-connection/android/src/test/java") }
}
dependencies {
    api(libs.serialization.json)
    implementation(libs.bouncycastle.prov)
    api(libs.okhttp)
    testImplementation(libs.junit)
}
tasks.test {
    systemProperty("phone.vectors", rootDir.resolve("../../packages/browser-core/test-vectors").canonicalPath)
    systemProperty("device.vectors", rootDir.resolve("../../packages/runner-auth/fixtures").canonicalPath)
}
