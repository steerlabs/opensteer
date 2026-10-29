package com.opensteer.agentphone

import com.opensteer.agentphone.wire.Json
import com.opensteer.agentphone.wire.JsonText
import java.io.File

/** Files the JVM tests share with the rest of the repository. */
object TestFiles {
    val repositoryRoot: File = File(requireNotNull(System.getProperty("opensteer.repositoryRoot")))
    val appDirectory: File = File(requireNotNull(System.getProperty("opensteer.appDirectory")))

    /** Written by `packages/runner-auth/src/agent-phone-vectors.test.ts` from the Host's own code. */
    val vectors: Json by lazy {
        JsonText.parse(repositoryRoot.resolve("packages/runner-auth/fixtures/agent-phone-vectors.json").readText())
    }
}
