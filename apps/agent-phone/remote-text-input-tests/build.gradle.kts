plugins { kotlin("jvm") }
layout.buildDirectory = rootProject.layout.buildDirectory.dir("remote-text-input-tests")
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../../mobile/modules/remote-text-input/android/src/main/java")
        kotlin.include("**/RemoteInputType.kt")
    }
    test { kotlin.srcDir("../../mobile/modules/remote-text-input/android/src/test/java") }
}
dependencies {
    compileOnly(libs.android.stubs)
    testImplementation(libs.android.stubs)
    testImplementation(libs.junit)
}
