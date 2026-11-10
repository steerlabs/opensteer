package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.serialization.json.*
import java.util.concurrent.CompletableFuture

class PhoneConnectionModule : Module() {
    private var instance: PhoneConnectionRuntime? = null
    private fun runtime() = instance ?: PhoneConnectionRuntime.get(appContext.reactContext ?: throw Refused("unavailable")).also { instance = it }
    override fun definition() = ModuleDefinition {
        Name("PhoneConnection")
        Events("onChange", "onEvent", "onRetire")
        OnCreate {
            runtime().observe({ sendEvent("onChange", it.native()) }, { sendEvent("onEvent", it.native()) },
                { sendEvent("onRetire", mapOf("deploymentId" to it)) })
            runtime().setActivityForeground((appContext.currentActivity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true)
        }
        OnActivityEntersForeground { runtime().setActivityForeground(true) }
        OnActivityEntersBackground { runtime().setActivityForeground(false) }
        OnDestroy { runtime().setActivityForeground(false); runtime().observe(null, null, null) }
        Function("getSnapshot") { runtime().snapshot().native() }
        Function("now") { runtime().now().toDouble() }
        Function("fence") { reason: String -> admitted { runtime().fence(reason) } }
        Function("disconnect") { runtime().disconnect().native() }
        AsyncFunction("prepare") { input: Map<String, Any?> -> admitted { runtime().prepare(input.objectValue().text("deploymentId")).native() } }
        AsyncFunction("enrollFromHost") { input: Map<String, Any?>, promise: Promise ->
          admitted {
            val value = input.objectValue()
            finish(promise, runtime().enrollFromHost(value.text("origin", max = 8192), value.text("authorization", max = 16384),
                value.text("deploymentId"), value.text("name", max = 120))) { it.native() }
          }
        }
        AsyncFunction("discardPendingEnrollment") { admitted { runtime().discardPendingEnrollment().native() } }
        AsyncFunction("retarget") { input: Map<String, Any?> -> admitted { runtime().retarget(input.objectValue()) } }
        AsyncFunction("completeRetirement") { promise: Promise -> admitted { finish(promise, runtime().completeRetirement()) { null } } }
        AsyncFunction("initialize") { input: Map<String, Any?> ->
          admitted {
            val value = input.objectValue()
            synchronized(runtime()) {
                runtime().requireEpoch(value.number("epoch", max = Int.MAX_VALUE.toLong()).toInt())
                runtime().qualify(value.text("deploymentId"), value.text("runnerId")).native()
            }
          }
        }
        AsyncFunction("setForeground") { input: Map<String, Any?> ->
          admitted {
            val value = input.objectValue()
            synchronized(runtime()) {
                runtime().requireEpoch(value.number("epoch", max = Int.MAX_VALUE.toLong()).toInt())
                runtime().setForeground(value["active"] == JsonPrimitive(true))
            }
          }
        }
        AsyncFunction("verifyAttach") { input: Map<String, Any?> ->
          admitted {
            val value = input.objectValue()
            runtime().browser().verifyAttach(value.number("epoch", max = Int.MAX_VALUE.toLong()).toInt(), value.text("attachHandle")).native()
          }
        }
        AsyncFunction("commitAttach") { input: Map<String, Any?> ->
          admitted {
            val value = input.objectValue()
            runtime().browser().commitAttach(value.number("epoch", max = Int.MAX_VALUE.toLong()).toInt(), value.text("attachHandle"), value.text("claimsDigest"), value.obj("replayTransition"))
          }
        }
        AsyncFunction("sendRelay") { input: Map<String, Any?> ->
          admitted {
            val value = input.objectValue()
            runtime().browser().send(value.number("epoch", max = Int.MAX_VALUE.toLong()).toInt(), value.obj("message"))
          }
        }
        AsyncFunction("closeChannel") { input: Map<String, Any?> ->
          admitted {
            val value = input.objectValue()
            runtime().browser().closeChannel(value.number("epoch", max = Int.MAX_VALUE.toLong()).toInt(), value.text("channelId"))
          }
        }
    }
    private fun <Value> finish(promise: Promise, future: CompletableFuture<Value>, transform: (Value) -> Any?) {
        future.whenComplete { value, error ->
            if (error != null) promise.reject(((error as? Refused) ?: (error.cause as? Refused))?.reason ?: "failed", "This phone cannot do that now.", null)
            else promise.resolve(transform(value))
        }
    }
    private fun <Value> admitted(action: () -> Value): Value = try { action() }
        catch (error: Exception) { throw CodedException((error as? Refused)?.reason ?: "failed", "This phone cannot do that now.", null) }
}

private fun Map<String, Any?>.objectValue(): JsonObject = JsonObject(mapValues { (_, value) -> value.element() })
private fun Any?.element(): JsonElement = when (this) {
    null -> JsonNull
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Number -> if (toDouble().isFinite() && toDouble() == toLong().toDouble()) JsonPrimitive(toLong()) else JsonPrimitive(toDouble())
    is Map<*, *> -> JsonObject(entries.associate { (key, value) -> (key as? String ?: throw Refused("invalid-wire")) to value.element() })
    is List<*> -> JsonArray(map { it.element() })
    else -> throw Refused("invalid-wire")
}
private fun JsonObject.native(): Map<String, Any?> = mapValues { (_, value) -> value.nativeValue() }
private fun JsonElement.nativeValue(): Any? = when (this) {
    is JsonObject -> native()
    is JsonArray -> map { it.nativeValue() }
    JsonNull -> null
    is JsonPrimitive -> if (isString) content else booleanOrNull ?: longOrNull?.toDouble() ?: doubleOrNull
}
