package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class PageLifecycleTest {
  @Test fun personPickerSurvivesAnEpochFenceButNotAReplacedPage() {
    val person = PageChooser(3, 1, "document", true)
    assertTrue(person.survivesFence())
    assertTrue(person.current(4, 1, "document"))
    assertFalse(person.current(4, 2, "document"))
    assertFalse(person.current(4, 1, null))
    assertFalse(person.current(4, 1, "navigation"))
    val agent = person.copy(person = false)
    assertFalse(agent.survivesFence())
    assertFalse(agent.current(4, 1, "document"))
    assertTrue(agent.current(3, 1, "document"))
  }
  @Test fun pageCloseDestroysBeforeEmittingExactlyOneNativeTabReference() {
    val lifecycle = PageClose()
    var destroyed = false
    val events = mutableListOf<Map<String, Any?>>()
    val ref = mapOf("epoch" to 3, "sessionId" to "session", "tabId" to "tab", "generation" to 2)
    repeat(2) { lifecycle.close(ref, { assertFalse(destroyed); destroyed = true }, { assertTrue(destroyed); events.add(it) }) }
    assertEquals(listOf(ref + ("type" to "closed")), events)
  }
  @Test fun connectionEpochIsAdoptedAndNeverIndependentlyAdvanced() {
    val gate = EpochGate()
    gate.adopt(7)
    assertEquals(7, gate.epoch)
    gate.adopt(7)
    assertThrows(BrowserFailure::class.java) { gate.adopt(6) }
    assertThrows(BrowserFailure::class.java) { gate.check(6) }
    gate.adopt(8)
    assertThrows(BrowserFailure::class.java) { gate.check(7) }
  }
  @Test fun expoNamesTrackTheSharedFacadeAndProps() {
    val repo = File(System.getProperty("phone.repo"))
    val facade = repo.resolve("apps/mobile/modules/phone-browser/index.ts").readText()
    val module = repo.resolve("apps/mobile/modules/phone-browser/android/src/main/java/com/opensteer/phonebrowser/PhoneBrowserModule.kt").readText()
    val event = Regex("native\\.addListener\\(\"([^\"]+)\"").find(facade)!!.groupValues[1]
    assertTrue(module.contains("Events(\"$event\")"))
    assertTrue(module.contains("sendEvent(\"$event\", event)"))
    val methods = Regex("native\\.([A-Za-z]+)\\(").findAll(facade).map { it.groupValues[1] }.filter { it != "addListener" }.toSet()
    for (method in methods) assertTrue("Missing $method", Regex("(?:AsyncFunction|Function)\\(\"$method\"\\)").containsMatchIn(module))
    val views = Regex("\"(PhoneBrowser(?:Host|Picture|Download))\"").findAll(facade).map { it.groupValues[1] }.toSet()
    for (view in views) assertTrue("Missing $view", module.contains("Name(\"$view\")"))
    for (prop in listOf("hostId", "tabId", "downloadId")) assertTrue(module.contains("Prop(\"$prop\")"))
  }
}
