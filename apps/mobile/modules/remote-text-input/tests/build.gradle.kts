plugins { kotlin("jvm") version "2.4.21" }
dependencies {
    compileOnly("com.google.android:android:4.1.1.4")
    testImplementation("com.google.android:android:4.1.1.4")
    testImplementation("junit:junit:4.13.2")
}
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../android/src/main/java")
        kotlin.include("**/RemoteInputType.kt")
    }
    test { kotlin.srcDir("../android/src/test/java") }
}
