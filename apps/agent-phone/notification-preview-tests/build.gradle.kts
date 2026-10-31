plugins { kotlin("jvm") }

kotlin { jvmToolchain(21) }

sourceSets {
  main {
    kotlin.srcDir("../../mobile/modules/notification-preview/android/src/main/java")
    kotlin.include("**/PreviewCrypto.kt", "**/PreviewNotification.kt")
  }
  test { kotlin.srcDir("../../mobile/modules/notification-preview/android/src/test/java") }
}

dependencies { testImplementation("junit:junit:4.13.2") }
