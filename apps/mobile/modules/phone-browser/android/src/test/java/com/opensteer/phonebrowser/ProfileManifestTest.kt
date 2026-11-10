package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class ProfileManifestTest {
  @Test fun guestTombstonePrecedesInitializationAndSurvivesRestart() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val binding = ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding")
    val entry = manifest.create(binding, false, true)
    val restarted = ProfileManifest({ durable }, { durable = it })
    assertNotNull(restarted.byHandle(entry.handle).deletionId)
    assertFalse(restarted.byHandle(entry.handle).initialized)
    manifest.initialized(entry.handle)
    assertNotNull(manifest.byHandle(entry.handle).deletionId)
  }

  @Test fun pendingErasureNeverBecomesDeletedUntilConfirmed() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val binding = ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding")
    val entry = manifest.create(binding, false, false)
    manifest.initialized(entry.handle)
    manifest.tombstone(entry.handle, "deletion")
    val restarted = ProfileManifest({ durable }, { durable = it })
    assertEquals("deletion", restarted.byHandle(entry.handle).deletionId)
    assertFalse(restarted.byHandle(entry.handle).deleted)
    restarted.deleted(entry.handle)
    assertTrue(ProfileManifest({ durable }, { durable = it }).byHandle(entry.handle).deleted)
  }

  @Test fun missingInitializedAndMismatchedBindingsFailClosed() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val binding = ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding")
    assertEquals("profile-missing", assertThrows(BrowserFailure::class.java) { manifest.create(binding, true, false) }.reason)
    manifest.create(binding, false, false)
    assertEquals("forbidden", assertThrows(BrowserFailure::class.java) { manifest.find(binding.copy(deploymentId = "another")) }.reason)
    assertThrows(BrowserFailure::class.java) { ProfileManifest({ "broken" }, {}) }
  }

  @Test fun failedPersistenceDoesNotPublishAnErasureTransition() {
    var durable: String? = null
    var failing = false
    val manifest = ProfileManifest({ durable }, { if (failing) throw IllegalStateException("disk unavailable"); durable = it })
    val entry = manifest.create(ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding"), false, false)
    failing = true
    assertThrows(IllegalStateException::class.java) { manifest.tombstone(entry.handle, "deletion") }
    assertNull(manifest.byHandle(entry.handle).deletionId)
    assertNull(ProfileManifest({ durable }, {}).byHandle(entry.handle).deletionId)
  }
}
