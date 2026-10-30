import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

plugins {
    alias(libs.plugins.android.application)
}

/** The repository the app ships in, whose release version the app carries. */
val repositoryRoot: File = rootDir.resolve("../..").canonicalFile

// The app is versioned with Opensteer itself, so the Host and setup can compare
// the phone's `runtimeVersion` with the release that bundled its APK.
val opensteerVersion: String =
    (JsonSlurper().parse(repositoryRoot.resolve("package.json")) as Map<*, *>)["version"] as String
val opensteerVersionParts: List<Int> =
    Regex("""^(\d+)\.(\d+)\.(\d+)$""").matchEntire(opensteerVersion)?.groupValues?.drop(1)?.map(String::toInt)
        ?: error("The root package.json version $opensteerVersion is not major.minor.patch")
check(opensteerVersionParts[1] < 1_000 && opensteerVersionParts[2] < 1_000) {
    "versionCode packs minor and patch into three digits each; $opensteerVersion does not fit"
}

/**
 * The end-to-end suite's test CA, for a debug build given
 * `-PopensteerE2eCa=<pem>`: that build trusts it, alongside user-installed
 * CAs, in `<debug-overrides>`, which Android honours for debuggable builds
 * alone. Only the debug variant compiles either, so a release never contains
 * them.
 */
val e2eCa = providers.gradleProperty("opensteerE2eCa")
val updateTestVersion = providers.gradleProperty("opensteerUpdateTestVersion")
val updateTestSigner = providers.gradleProperty("opensteerUpdateTestSigner")
val updateTestKeystore = providers.gradleProperty("opensteerUpdateTestKeystore")

/** Release signing comes only from the environment, so a key never lives in the checkout. */
val releaseSigning = listOf(
    "OPENSTEER_AGENT_PHONE_KEYSTORE",
    "OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD",
    "OPENSTEER_AGENT_PHONE_KEY_ALIAS",
    "OPENSTEER_AGENT_PHONE_KEY_PASSWORD",
).associateWith { providers.environmentVariable(it) }

android {
    namespace = "com.opensteer.agentphone"
    compileSdk = 37

    buildFeatures { buildConfig = true }
    defaultConfig {
        val releasePin = (JsonSlurper().parse(repositoryRoot.resolve("packages/protocol/src/agent-phone-release.json")) as Map<*, *>)["signingCertSha256"] as String
        buildConfigField("String", "AGENT_PHONE_UPDATE_SIGNER", "\"$releasePin\"")
        applicationId = "com.opensteer.agentphone"
        minSdk = 30
        targetSdk = 36
        testInstrumentationRunner = providers.gradleProperty("opensteerInstrumentation")
            .getOrElse("com.opensteer.agentphone.runner.IdentityStoreInstrumentation")
        versionCode =
            opensteerVersionParts[0] * 1_000_000 + opensteerVersionParts[1] * 1_000 + opensteerVersionParts[2]
        versionName = opensteerVersion
    }

    signingConfigs {
        create("updateTest") {
            updateTestKeystore.orNull?.let { storeFile = file(it) }
            storePassword = "opensteer-test"
            keyPassword = "opensteer-test"
            keyAlias = "update-test"
        }
        create("release") {
            releaseSigning.getValue("OPENSTEER_AGENT_PHONE_KEYSTORE").orNull?.let { storeFile = file(it) }
            storePassword = releaseSigning.getValue("OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD").orNull
            keyAlias = releaseSigning.getValue("OPENSTEER_AGENT_PHONE_KEY_ALIAS").orNull
            keyPassword = releaseSigning.getValue("OPENSTEER_AGENT_PHONE_KEY_PASSWORD").orNull
        }
    }

    buildTypes {
        // Explicit test-only, nondebuggable APKs exercise the release updater without the permanent key.
        create("updateTest") {
            isDebuggable = false
            signingConfig = signingConfigs.getByName("updateTest")
            buildConfigField("String", "AGENT_PHONE_UPDATE_SIGNER", "\"${updateTestSigner.getOrElse("unconfigured-test-signer")}\"")
            manifestPlaceholders["networkSecurityConfig"] = if (e2eCa.isPresent) "@xml/network_security_config_update_test" else "@xml/network_security_config"
        }
        debug {
            manifestPlaceholders["networkSecurityConfig"] =
                if (e2eCa.isPresent) "@xml/network_security_config_e2e" else "@xml/network_security_config_debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Never the debug key: a release signed by it could be replaced by any
            // build anyone signs with the same well-known key.
            signingConfig = signingConfigs.getByName("release")
            manifestPlaceholders["networkSecurityConfig"] = "@xml/network_security_config"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all {
            // The golden vectors and the wire fixture live in the repository, outside this build.
            it.systemProperty("opensteer.repositoryRoot", repositoryRoot.absolutePath)
            it.systemProperty("opensteer.appDirectory", projectDir.absolutePath)
            // Read at run time, so a regenerated fixture is never answered with an earlier run's result.
            it.inputs.file(repositoryRoot.resolve("packages/protocol/fixtures/login-envelope-v1.json"))
                .withPropertyName("loginEnvelopeVectors")
                .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.NONE)
            it.inputs.file(repositoryRoot.resolve("packages/runner-auth/fixtures/agent-phone-vectors.json"))
                .withPropertyName("goldenVectors")
                .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.NONE)
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(libs.okhttp)
    implementation(libs.bouncycastle.prov)
    testImplementation(libs.junit)
}

/**
 * Fails a release build before anything is packaged when its signing key is
 * not in the environment. Without this the release would come out unsigned or
 * signed by whatever a default supplied.
 */
val verifyReleaseSigning = tasks.register("verifyReleaseSigning") {
    val missing = releaseSigning.filterValues { !it.isPresent }.keys
    doLast {
        check(missing.isEmpty()) { "A release build needs its signing key; set ${missing.joinToString()}." }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyReleaseSigning) }

/** Copies the end-to-end suite's PEM in as `raw/opensteer_e2e_ca`, the resource its configuration names. */
abstract class E2eCaResource : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val certificate: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun copy() {
        val pem = certificate.get().asFile.readText()
        check(pem.contains("-----BEGIN CERTIFICATE-----")) { "opensteerE2eCa must be a PEM certificate: ${certificate.get().asFile}" }
        val raw = outputDirectory.get().dir("raw").asFile
        raw.deleteRecursively()
        raw.mkdirs()
        raw.resolve("opensteer_e2e_ca.pem").writeText(pem)
        val xml = outputDirectory.get().dir("xml").asFile
        xml.mkdirs()
        xml.resolve("network_security_config_update_test.xml").writeText("""
            <network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/><certificates src="@raw/opensteer_e2e_ca"/></trust-anchors></base-config></network-security-config>
        """.trimIndent())
    }
}

androidComponents {
    onVariants(selector().all()) { variant ->
        if (variant.buildType == "updateTest" && updateTestVersion.isPresent) {
            val version = updateTestVersion.get()
            val parts = version.split('.').map(String::toInt)
            check(parts.size == 3 && parts[1] < 1000 && parts[2] < 1000)
            variant.outputs.forEach {
                it.versionName.set(version)
                it.versionCode.set(parts[0] * 1_000_000 + parts[1] * 1000 + parts[2])
            }
        }
        if (!e2eCa.isPresent || variant.buildType !in setOf("debug", "updateTest")) return@onVariants
        val resource = tasks.register<E2eCaResource>("copyE2eCa${variant.name.replaceFirstChar(Char::uppercaseChar)}") {
            certificate.set(layout.file(e2eCa.map { File(it) }))
            outputDirectory.set(layout.buildDirectory.dir("generated/agent-phone/e2e-ca/${variant.name}"))
        }
        variant.sources.res?.addStaticSourceDirectory("src/e2e/res")
        variant.sources.res?.addGeneratedSourceDirectory(resource, E2eCaResource::outputDirectory)
    }
}
