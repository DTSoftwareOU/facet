package io.dtsoftware.facet.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class RemotePathsTest {
    @Test
    fun folderNames() {
        assertEquals("app", RemotePaths.name("C:\\Users\\alex\\app"))
        assertEquals("app", RemotePaths.name("C:\\Users\\alex\\app\\"))
        assertEquals("C:", RemotePaths.name("C:\\"))
        assertEquals("alex", RemotePaths.name("/home/alex"))
        assertEquals("/", RemotePaths.name("/"))
    }

    @Test
    fun breadcrumbs() {
        assertEquals(
            listOf("C:" to "C:\\", "Users" to "C:\\Users", "alex" to "C:\\Users\\alex"),
            RemotePaths.crumbs("C:\\Users\\alex"),
        )
        assertEquals(listOf("D:" to "D:\\"), RemotePaths.crumbs("d:\\"))
        assertEquals(
            listOf("\\\\nas\\share" to "\\\\nas\\share\\", "docs" to "\\\\nas\\share\\docs"),
            RemotePaths.crumbs("\\\\nas\\share\\docs"),
        )
        assertEquals(listOf("/" to "/", "home" to "/home", "alex" to "/home/alex"), RemotePaths.crumbs("/home/alex/"))
    }
}
