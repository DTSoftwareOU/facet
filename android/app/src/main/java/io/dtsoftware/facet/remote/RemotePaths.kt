package io.dtsoftware.facet.remote

/** Display helpers for paths on a PC (Windows paths, and POSIX ones for good measure). */
object RemotePaths {
    private val drive = Regex("^[A-Za-z]:")

    /** The folder's own name: "C:\Users\alex\app" → "app", "C:\" → "C:". */
    fun name(path: String): String {
        val trimmed = path.trimEnd('\\', '/')
        if (trimmed.isEmpty()) return path
        return trimmed.substringAfterLast('\\').substringAfterLast('/').ifEmpty { trimmed }
    }

    /** Breadcrumbs from the root: (label, path) pairs, e.g. ("C:", "C:\"), ("Users", "C:\Users"), ("alex", "C:\Users\alex"). */
    fun crumbs(path: String): List<Pair<String, String>> {
        val sep = if ('\\' in path || drive.containsMatchIn(path)) '\\' else '/'
        val out = ArrayList<Pair<String, String>>()
        val rest: List<String>
        var current: String
        when {
            path.startsWith("\\\\") -> {
                // \\server\share is the root of a network path.
                val parts = path.drop(2).split('\\', '/').filter { it.isNotEmpty() }
                if (parts.size < 2) return listOf(path to path)
                current = "\\\\" + parts[0] + "\\" + parts[1]
                out += current to current + "\\"
                rest = parts.drop(2)
            }
            drive.containsMatchIn(path) -> {
                current = path.take(2).uppercase()
                out += current to current + sep
                rest = path.drop(2).split('\\', '/').filter { it.isNotEmpty() }
            }
            path.startsWith("/") -> {
                current = ""
                out += "/" to "/"
                rest = path.split('/').filter { it.isNotEmpty() }
            }
            else -> {
                current = ""
                rest = path.split('\\', '/').filter { it.isNotEmpty() }
            }
        }
        for (part in rest) {
            current = if (current.isEmpty() && sep == '/' && path.startsWith("/")) "/$part" else if (current.isEmpty()) part else current + sep + part
            out += part to current
        }
        return out
    }
}
