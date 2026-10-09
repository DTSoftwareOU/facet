package io.dtsoftware.facet.ui

import androidx.compose.ui.graphics.vector.PathParser
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every vector path must parse with Compose's (stricter) parser, or painterResource crashes at runtime. */
class IconResourcesTest {
    @Test
    fun allVectorPathsParse() {
        val dirs = listOf("src/main/res/drawable", "src/main/res/mipmap-anydpi", "src/debug/res/xml").map(::File).filter { it.exists() }
        assertTrue("resource dirs not found from ${File(".").absolutePath}", dirs.isNotEmpty())
        val regex = Regex("android:pathData=\"([^\"]*)\"")
        var count = 0
        dirs.flatMap { it.listFiles { f -> f.extension == "xml" }.orEmpty().toList() }.forEach { file ->
            regex.findAll(file.readText()).forEach { m ->
                val d = m.groupValues[1]
                runCatching { PathParser().parsePathString(d).toNodes() }
                    .onFailure { throw AssertionError("${file.name}: invalid path \"$d\"", it) }
                count++
            }
        }
        assertTrue(count > 100)
    }
}
