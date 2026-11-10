plugins { kotlin("jvm") }
layout.buildDirectory = rootProject.layout.buildDirectory.dir("phone-browser-tests")
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../../mobile/modules/phone-browser/android/src/main/java")
        kotlin.include("**/BrowserState.kt", "**/ProfileManifest.kt", "**/PageLifecycle.kt", "**/PhoneBrowserNative.kt", "**/PhoneBrowserServices.kt", "**/PagePresentation.kt")
    }
    test { kotlin.srcDir("../../mobile/modules/phone-browser/android/src/test/java") }
}
dependencies {
    implementation(project(":phone-connection-tests"))
    implementation(libs.json)
    testImplementation(libs.bouncycastle.prov)
    testImplementation(libs.junit)
}
tasks.test {
    systemProperty("phone.vectors", rootDir.resolve("../../packages/browser-core/test-vectors").canonicalPath)
    systemProperty("phone.repo", rootDir.resolve("../..").canonicalPath)
}
