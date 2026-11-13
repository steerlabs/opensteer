package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*

/** The browser module this phone advertises; `phone-descriptors.v1.json` keeps it on the wire `descriptor.ts` writes. */
object BrowserDescriptor {
    fun from(qualified: JsonObject): JsonObject {
        Wire.requireThat(qualified["browser"] == JsonPrimitive(true) && qualified["sharedControl"] == JsonPrimitive(true) &&
            qualified["platform"] == JsonPrimitive("android"), "unsupported")
        val browser = linkedMapOf<String, JsonElement>("runtimeId" to qualified.getValue("runtimeId"), "wireVersion" to JsonPrimitive(2),
            "localProfileStorage" to Wire.fields("storageInstanceId" to qualified.getValue("storageInstanceId"), "engine" to JsonPrimitive("android-webview")))
        for (key in listOf("navigationVersion", "navigationAttributionVersion", "tabRestoreVersion", "popupFollowVersion", "sharedControl", "targetControl", "rasterDemand", "basicInput", "surfaceState")) browser[key] = JsonPrimitive(1)
        if (qualified["cdpBoundary"] == JsonPrimitive(true)) browser["cdpBoundary"] = JsonPrimitive(1)
        if (qualified["fileStaging"] == JsonPrimitive(true)) browser["fileStaging"] = JsonPrimitive(true)
        return JsonObject(browser)
    }
}
