package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class ProfileManifestTest {
  @Test fun guestTabsShareOneSessionProfileUntilTheLastTabReleasesIt() {
    val sessions = GuestSessionProfiles()
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    var allocations = 0
    fun open(deployment: String, session: String) = sessions.getOrCreate(deployment, "runner", session) {
      allocations++
      java.util.concurrent.CompletableFuture.completedFuture(manifest.create(ProfileBinding(deployment, "runner", manifest.storageInstanceId, "profile-$allocations", "binding-$allocations"), false, true))
    }.getNow(null)
    val first = open("deployment", "session-a")
    assertSame(first, open("deployment", "session-a"))
    assertNotEquals(first.handle, open("deployment", "session-b").handle)
    assertNotEquals(first.handle, open("other-deployment", "session-a").handle)
    assertEquals(3, allocations)
    sessions.remove(first.handle)
    assertNotEquals(first.handle, open("deployment", "session-a").handle)
    assertEquals(4, allocations)
  }
  @Test fun confirmedGuestErasureCompactsButNamedDeletionAndPendingGuestsSurvive() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    fun binding(id: String) = ProfileBinding("deployment", "runner", manifest.storageInstanceId, id, id)
    val pending = manifest.create(binding("pending"), false, true)
    val erased = manifest.create(binding("erased"), false, true)
    val named = manifest.create(binding("named"), false, false)
    manifest.tombstone(named.handle, "deletion")
    manifest.deleted(named.handle)
    manifest.deleted(erased.handle)
    assertEquals(setOf(pending.handle, named.handle), manifest.all().map { it.handle }.toSet())
    val restarted = ProfileManifest({ durable }, {})
    assertEquals(setOf(pending.handle, named.handle), restarted.all().map { it.handle }.toSet())
    assertTrue(restarted.byHandle(named.handle).deleted)
    assertNotNull(restarted.byHandle(pending.handle).deletionId)
  }
  @Test fun writeBudgetRefusesBeforePersistenceAndLeavesTheManifestReadable() {
    var durable: String? = null
    val manifest = ProfileManifest({ durable }, { durable = it })
    val binding = ProfileBinding("deployment", "runner", manifest.storageInstanceId, "profile", "binding")
    manifest.create(binding, false, false)
    val before = durable
    assertEquals("profile-manifest-full", assertThrows(BrowserFailure::class.java) {
      manifest.create(binding.copy(profileId = "x".repeat(1048576), bindingId = "another"), false, true)
    }.reason)
    assertEquals(before, durable)
    assertEquals(manifest.all(), ProfileManifest({ durable }, {}).all())
  }
  @Test fun allocationsAtTheReadBoundaryNeverMakeTheNextStartupUnreadable() {
    val storage = java.util.UUID.randomUUID().toString()
    fun entry() : ProfileEntry {
      val handle = java.util.UUID.randomUUID().toString()
      return ProfileEntry(handle, "opensteer_pb_" + handle.replace("-", ""), ProfileBinding("dep", "runner", storage, java.util.UUID.randomUUID().toString(), java.util.UUID.randomUUID().toString()), false, true, java.util.UUID.randomUUID().toString(), true)
    }
    val sample = entry()
    val count = (1048576 - 200) / (sample.json().toString().length + 1) - 1
    var durable = org.json.JSONObject().put("version", 1).put("storageInstanceId", storage).put("entries", org.json.JSONArray(List(count) { entry().json() })).toString()
    val manifest = ProfileManifest({ durable }, { durable = it })
    var accepted = 0
    var refused = 0
    repeat(8) {
      try {
        manifest.create(entry().binding, false, true)
        accepted++
      } catch (error: BrowserFailure) {
        assertEquals("profile-manifest-full", error.reason)
        refused++
      }
      assertEquals(manifest.all(), ProfileManifest({ durable }, {}).all())
      assertTrue(durable.toByteArray(Charsets.UTF_8).size <= 1048576)
    }
    assertTrue(accepted > 0)
    assertTrue(refused > 0)
    val existing = manifest.all().first()
    manifest.tombstone(existing.handle, java.util.UUID.randomUUID().toString())
    assertEquals(manifest.all(), ProfileManifest({ durable }, {}).all())
  }
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
