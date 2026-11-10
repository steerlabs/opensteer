package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class ProfileManifestTest {
  @Test fun startupRetiresUntombstonedProfilesFromAnInterruptedDeploymentErasure() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val pending = manifest.create(ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding"), false, false)
    val alreadyRetiring = manifest.create(ProfileBinding("deployment", "old-runner", manifest.storageInstanceId, "old-profile", "old-binding"), false, false)
    manifest.tombstone(alreadyRetiring.handle, "existing-deletion")
    val unrelated = manifest.create(ProfileBinding("other-deployment", "runner", manifest.storageInstanceId, "other-profile", "other-binding"), false, false)
    val restarted = ProfileManifest({ durable }, { durable = it })
    assertNull(restarted.byHandle(pending.handle).deletionId)
    restarted.retireDeployment("deployment")
    val tombstoned = ProfileManifest({ durable }, { durable = it })
    assertNotNull(tombstoned.byHandle(pending.handle).deletionId)
    assertFalse(tombstoned.byHandle(pending.handle).deleted)
    assertNull(tombstoned.byHandle(unrelated.handle).deletionId)
    tombstoned.retireDeployment("deployment")
    assertEquals("existing-deletion", tombstoned.byHandle(alreadyRetiring.handle).deletionId)
    tombstoned.deleted(pending.handle)
    assertTrue(ProfileManifest({ durable }, { durable = it }).byHandle(pending.handle).deleted)
  }
  @Test fun guestErasureRefusesRetirementUntilDeletionIsConfirmedAfterRestart() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val guest = manifest.create(ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding"), false, true)
    try {
      manifest.requireGuestsErased("deployment")
      fail("A tombstone is not confirmed erasure")
    } catch (error: com.opensteer.phoneconnection.core.Refused) {
      assertEquals("erasure-pending", error.reason)
    }
    manifest.requireGuestsErased("another-deployment")
    val restarted = ProfileManifest({ durable }, { durable = it })
    restarted.deleted(guest.handle)
    restarted.requireGuestsErased("deployment")
  }
  @Test fun repeatedEnrollmentInventoriesOnlyTheCurrentRunnerWithoutLosingOldErasure() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val old = manifest.create(ProfileBinding("deployment", "old-runner", manifest.storageInstanceId, "old-profile", "old-binding"), false, false)
    manifest.tombstone(old.handle, "old-deletion")
    manifest.deleted(old.handle)
    val current = manifest.create(ProfileBinding("deployment", "new-runner", manifest.storageInstanceId, "new-profile", "new-binding"), false, false)
    manifest.tombstone(current.handle, "new-deletion")
    val restarted = ProfileManifest({ durable }, { durable = it })
    assertEquals(listOf(current.handle), restarted.inventory("deployment", "new-runner").map { it.handle })
    assertEquals("new-deletion", restarted.inventory("deployment", "new-runner").single().deletionId)
    assertFalse(restarted.inventory("deployment", "new-runner").single().deleted)
    assertTrue(restarted.byHandle(old.handle).deleted)
    restarted.deleted(current.handle)
    assertTrue(restarted.inventory("deployment", "new-runner").single().deleted)
    assertTrue(restarted.inventory("another-deployment", "new-runner").isEmpty())
  }

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
