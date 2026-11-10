plugins { kotlin("jvm") version "2.4.21" }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    testImplementation("junit:junit:4.13.2")
}
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../android/src/main/java")
        kotlin.include("**/core/**", "**/BrowserTransport.kt")
    }
    test { kotlin.srcDir("../android/src/test/java") }
}
tasks.test {
    systemProperty("phone.vectors", rootDir.resolve("../../../../../packages/browser-core/test-vectors").canonicalPath)
}
