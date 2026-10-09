package io.dtsoftware.facet.ui.markdown

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import io.dtsoftware.facet.ui.theme.SyntaxColors

/**
 * Fast, dependency-free syntax highlighting. One linear pass per language family, no regexes.
 * Unknown languages get a generic pass (strings, numbers, comments).
 */
object SyntaxHighlighter {

    /** Above this size code is shown without highlighting. */
    const val MAX_CHARS = 30_000

    enum class Token { KEYWORD, STRING, NUMBER, COMMENT, FUNCTION, TYPE, ANNOTATION, PUNCTUATION, TAG, ATTRIBUTE }

    fun highlight(code: String, language: String?, colors: SyntaxColors): AnnotatedString {
        if (code.isEmpty()) return AnnotatedString("")
        if (code.length > MAX_CHARS) return AnnotatedString(code)
        val spans = tokenize(code, language)
        if (spans.isEmpty()) return AnnotatedString(code)
        val b = AnnotatedString.Builder(code)
        var i = 0
        while (i < spans.size) {
            val t = Token.entries[spans[i]]
            val style = styleFor(t, colors)
            b.addStyle(style, spans[i + 1], spans[i + 2])
            i += 3
        }
        return b.toAnnotatedString()
    }

    /** Pretty name for a fence language tag, e.g. "kt" → "Kotlin". */
    fun displayName(language: String?): String {
        val key = language?.trim()?.lowercase().orEmpty()
        if (key.isEmpty()) return "text"
        return DISPLAY[key] ?: key
    }

    /**
     * Returns token spans as a flat int array list: [token ordinal, start, end, …],
     * ordered and non-overlapping, adjacent same-token spans merged.
     */
    internal fun tokenize(code: String, language: String?): IntArray {
        val lang = resolve(language)
        val out = SpanSink()
        when (lang) {
            null -> GenericLexer(GENERIC, code, out).run()
            Lang.JSON -> JsonLexer(code, out).run()
            Lang.YAML -> YamlLexer(code, out).run()
            Lang.TOML -> TomlLexer(code, out).run()
            Lang.MARKUP -> MarkupLexer(code, out).run()
            Lang.CSS -> CssLexer(code, out).run()
            Lang.DIFF -> DiffLexer(code, out).run()
            Lang.PLAIN -> Unit
            else -> GenericLexer(lang.spec!!, code, out).run()
        }
        return out.toArray()
    }

    private fun styleFor(t: Token, c: SyntaxColors): SpanStyle = when (t) {
        Token.KEYWORD -> SpanStyle(color = c.keyword)
        Token.STRING -> SpanStyle(color = c.string)
        Token.NUMBER -> SpanStyle(color = c.number)
        Token.COMMENT -> SpanStyle(color = c.comment, fontStyle = FontStyle.Italic)
        Token.FUNCTION -> SpanStyle(color = c.function)
        Token.TYPE -> SpanStyle(color = c.type)
        Token.ANNOTATION -> SpanStyle(color = c.annotation)
        Token.PUNCTUATION -> SpanStyle(color = c.punctuation)
        Token.TAG -> SpanStyle(color = c.tag)
        Token.ATTRIBUTE -> SpanStyle(color = c.attribute)
    }

    // ------------------------------------------------------------------ language table

    private class Spec(
        val keywords: Set<String>,
        val types: Set<String> = emptySet(),
        val literals: Set<String> = setOf("true", "false", "null"),
        val builtins: Set<String> = emptySet(),
        val lineComments: List<String> = listOf("//"),
        val blockComment: Pair<String, String>? = "/*" to "*/",
        val quotes: String = "\"'",
        val tripleQuotes: Boolean = false,
        val backtickStrings: Boolean = false,
        val annotationChar: Char? = null,
        val variableChar: Char? = null,
        val capitalizedTypes: Boolean = true,
        val caseInsensitive: Boolean = false,
        val hashComments: Boolean = false,
        val preprocessor: Boolean = false,
        val rustLifetimes: Boolean = false,
        val stringPrefixes: Set<String> = emptySet(),
        val dashCmdlets: Boolean = false,
        val symbols: Boolean = false,
        val singleQuoteIsChar: Boolean = false,
    )

    private enum class Lang(val spec: Spec?) {
        KOTLIN(Spec(
            keywords = words("package import class interface object fun val var if else when for while do return break continue throw try catch finally in is as typealias this super constructor init companion data sealed enum abstract open override private protected public internal inline suspend operator infix tailrec lateinit const vararg reified crossinline noinline out by where get set annotation actual expect value external"),
            types = words("Int Long Short Byte Double Float Boolean Char String Unit Any Nothing Array List Map Set MutableList MutableMap MutableSet Sequence Pair Triple"),
            annotationChar = '@', tripleQuotes = true,
        )),
        JAVA(Spec(
            keywords = words("package import class interface enum record extends implements new return if else for while do switch case default break continue throw throws try catch finally this super static final abstract public private protected synchronized volatile transient native strictfp instanceof assert void var yield sealed permits non-sealed module requires exports"),
            types = words("int long short byte double float boolean char String Object Integer Long Double Boolean List Map Set"),
            annotationChar = '@', tripleQuotes = true, singleQuoteIsChar = true,
        )),
        JS(Spec(
            keywords = words("var let const function return if else for while do switch case default break continue throw try catch finally new delete typeof instanceof in of class extends super this import export from as async await yield static get set void debugger with interface type enum implements private public protected readonly abstract declare namespace module keyof infer satisfies is"),
            types = words("string number boolean any unknown never object symbol bigint Array Promise Map Set Record Partial Readonly Date Error RegExp JSON Math Object String Number Boolean"),
            literals = words("true false null undefined NaN Infinity"),
            backtickStrings = true, annotationChar = '@',
        )),
        PYTHON(Spec(
            keywords = words("def class return if elif else for while break continue pass import from as try except finally raise with lambda yield global nonlocal assert del in is not and or async await match case type"),
            types = words("int float str bool list dict set tuple bytes object type complex frozenset"),
            literals = words("True False None"),
            builtins = words("print len range open enumerate zip map filter sorted sum min max abs isinstance super self cls"),
            lineComments = emptyList(), blockComment = null, hashComments = true, tripleQuotes = true, annotationChar = '@',
            stringPrefixes = words("r b f u rb br fr rf R B F U"),
        )),
        GO(Spec(
            keywords = words("package import func return if else for range switch case default break continue goto fallthrough defer go select chan map struct interface type var const"),
            types = words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any"),
            literals = words("true false nil iota"),
            builtins = words("make new len cap append copy delete panic recover print println close"),
            backtickStrings = true, singleQuoteIsChar = true,
        )),
        RUST(Spec(
            keywords = words("fn let mut const static if else match for while loop break continue return struct enum impl trait type pub use mod crate super self Self where as in ref move unsafe async await dyn extern"),
            types = words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet"),
            literals = words("true false None Some Ok Err"),
            rustLifetimes = true, annotationChar = '#',
        )),
        C(Spec(
            keywords = words("if else for while do switch case default break continue return goto struct union enum typedef sizeof static extern const volatile register inline auto signed unsigned class public private protected virtual override final template typename namespace using new delete this throw try catch operator friend explicit constexpr nullptr noexcept decltype mutable"),
            types = words("int long short char float double void bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t std string vector map"),
            literals = words("true false NULL nullptr"),
            preprocessor = true, singleQuoteIsChar = true,
        )),
        CSHARP(Spec(
            keywords = words("using namespace class struct interface enum record public private protected internal static readonly const sealed abstract virtual override new return if else for foreach while do switch case default break continue throw try catch finally this base get set init value var async await yield in out ref params is as where select from orderby group into let join"),
            types = words("int long short byte double float decimal bool char string object void dynamic List Dictionary Task IEnumerable"),
            annotationChar = null, singleQuoteIsChar = true,
        )),
        SWIFT(Spec(
            keywords = words("import class struct enum protocol extension func var let if else guard switch case default for while repeat return break continue throw throws rethrows try catch defer do in where as is init deinit self super static private fileprivate internal public open override mutating async await some any typealias associatedtype inout"),
            types = words("Int Double Float Bool String Character Array Dictionary Set Optional Any Void"),
            literals = words("true false nil"),
            annotationChar = '@', tripleQuotes = true,
        )),
        RUBY(Spec(
            keywords = words("def end class module if elsif else unless case when while until for in do return break next redo retry yield begin rescue ensure raise then self super require require_relative attr_accessor attr_reader attr_writer private protected public lambda proc and or not"),
            literals = words("true false nil"),
            lineComments = emptyList(), blockComment = null, hashComments = true, annotationChar = '@', symbols = true,
        )),
        PHP(Spec(
            keywords = words("function class interface trait extends implements public private protected static final abstract return if else elseif foreach for while do switch case default break continue throw try catch finally new echo print use namespace require include require_once include_once as fn match readonly enum"),
            literals = words("true false null TRUE FALSE NULL"),
            hashComments = true, variableChar = '$',
        )),
        SQL(Spec(
            keywords = words("select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full cross on as group by order having limit offset union all distinct case when then else end is null like in between exists primary key foreign references default constraint unique check returning with recursive asc desc begin commit rollback transaction grant revoke if replace trigger function procedure language returns"),
            types = words("int integer bigint smallint serial text varchar char boolean bool date timestamp timestamptz numeric decimal real float double json jsonb uuid blob"),
            literals = words("true false null"),
            lineComments = listOf("--"), caseInsensitive = true, capitalizedTypes = false,
        )),
        SHELL(Spec(
            keywords = words("if then else elif fi for while until do done case esac in function return break continue select time local export readonly declare unset shift"),
            builtins = words("echo cd ls cat grep sed awk find xargs curl wget git npm npx yarn pnpm node python python3 pip pip3 docker kubectl sudo apt brew chmod chown mkdir rm cp mv touch source exit printf read test tar ssh scp make go cargo gradle java"),
            literals = emptySet(),
            lineComments = emptyList(), blockComment = null, hashComments = true, variableChar = '$', capitalizedTypes = false,
        )),
        POWERSHELL(Spec(
            keywords = words("function param begin process end if elseif else foreach for while do until switch return break continue throw try catch finally trap filter in class enum using"),
            literals = words("\$true \$false \$null"),
            lineComments = emptyList(), blockComment = "<#" to "#>", hashComments = true, variableChar = '$',
            capitalizedTypes = false, caseInsensitive = true, dashCmdlets = true,
        )),
        DART(Spec(
            keywords = words("import export library part class extends implements with mixin abstract interface enum typedef void var final const late required static return if else for while do switch case default break continue throw try catch finally on new this super async await yield get set factory operator external sealed base"),
            types = words("int double num bool String List Map Set Future Stream dynamic Object Iterable"),
            annotationChar = '@', tripleQuotes = true,
        )),
        LUA(Spec(
            keywords = words("function local end if then elseif else for in do while repeat until return break goto and or not"),
            literals = words("true false nil"),
            builtins = words("print pairs ipairs require type tostring tonumber setmetatable getmetatable table string math"),
            lineComments = listOf("--"), blockComment = "--[[" to "]]", capitalizedTypes = false,
        )),
        R(Spec(
            keywords = words("function if else for while repeat break next return in library require"),
            literals = words("TRUE FALSE NULL NA NaN Inf T F"),
            lineComments = emptyList(), blockComment = null, hashComments = true, capitalizedTypes = false,
        )),
        JSON(null), YAML(null), TOML(null), MARKUP(null), CSS(null), DIFF(null), PLAIN(null),
    }

    private val GENERIC = Spec(
        keywords = emptySet(), literals = words("true false null nil None True False"),
        hashComments = true, capitalizedTypes = false,
    )

    private fun words(s: String): Set<String> = s.split(' ').filter { it.isNotEmpty() }.toHashSet()

    private val ALIASES: Map<String, Lang> = buildMap {
        fun put(lang: Lang, vararg names: String) = names.forEach { put(it, lang) }
        put(Lang.KOTLIN, "kotlin", "kt", "kts")
        put(Lang.JAVA, "java", "groovy", "scala")
        put(Lang.JS, "javascript", "js", "jsx", "mjs", "cjs", "node", "typescript", "ts", "tsx", "mts", "cts")
        put(Lang.PYTHON, "python", "py", "python3", "py3", "pyi", "ipython", "jupyter")
        put(Lang.GO, "go", "golang")
        put(Lang.RUST, "rust", "rs")
        put(Lang.C, "c", "h", "cpp", "c++", "cc", "cxx", "hpp", "hh", "objc", "objective-c", "arduino", "cuda", "glsl", "hlsl", "zig")
        put(Lang.CSHARP, "csharp", "cs", "c#", "fsharp", "f#")
        put(Lang.SWIFT, "swift")
        put(Lang.RUBY, "ruby", "rb", "crystal")
        put(Lang.PHP, "php")
        put(Lang.SQL, "sql", "postgres", "postgresql", "psql", "mysql", "sqlite", "plsql", "tsql", "graphql", "gql")
        put(Lang.SHELL, "bash", "sh", "shell", "zsh", "fish", "console", "terminal", "shellsession", "ksh", "dockerfile", "docker", "makefile", "make")
        put(Lang.POWERSHELL, "powershell", "ps1", "ps", "pwsh", "psm1", "bat", "cmd", "batch")
        put(Lang.DART, "dart")
        put(Lang.LUA, "lua")
        put(Lang.R, "r")
        put(Lang.JSON, "json", "jsonc", "json5", "jsonl", "geojson")
        put(Lang.YAML, "yaml", "yml")
        put(Lang.TOML, "toml", "ini", "cfg", "conf", "properties", "env", "dotenv")
        put(Lang.MARKUP, "html", "xml", "svg", "xhtml", "htm", "vue", "svelte", "plist", "xaml", "jsx-html")
        put(Lang.CSS, "css", "scss", "sass", "less")
        put(Lang.DIFF, "diff", "patch", "udiff")
        put(Lang.PLAIN, "text", "txt", "plain", "plaintext", "markdown", "md", "output", "log")
    }

    private val DISPLAY = mapOf(
        "kotlin" to "Kotlin", "kt" to "Kotlin", "kts" to "Kotlin script", "java" to "Java", "groovy" to "Groovy", "scala" to "Scala",
        "javascript" to "JavaScript", "js" to "JavaScript", "jsx" to "JSX", "mjs" to "JavaScript", "cjs" to "JavaScript",
        "typescript" to "TypeScript", "ts" to "TypeScript", "tsx" to "TSX", "python" to "Python", "py" to "Python",
        "python3" to "Python", "go" to "Go", "golang" to "Go", "rust" to "Rust", "rs" to "Rust", "c" to "C", "h" to "C header",
        "cpp" to "C++", "c++" to "C++", "cc" to "C++", "hpp" to "C++ header", "csharp" to "C#", "cs" to "C#", "c#" to "C#",
        "swift" to "Swift", "ruby" to "Ruby", "rb" to "Ruby", "php" to "PHP", "sql" to "SQL", "bash" to "Bash",
        "sh" to "Shell", "shell" to "Shell", "zsh" to "Zsh", "fish" to "Fish", "console" to "Terminal", "terminal" to "Terminal",
        "powershell" to "PowerShell", "ps1" to "PowerShell", "pwsh" to "PowerShell", "dart" to "Dart", "lua" to "Lua", "r" to "R",
        "json" to "JSON", "jsonc" to "JSON", "yaml" to "YAML", "yml" to "YAML", "toml" to "TOML", "ini" to "INI",
        "html" to "HTML", "xml" to "XML", "svg" to "SVG", "css" to "CSS", "scss" to "SCSS", "sass" to "Sass", "less" to "Less",
        "diff" to "Diff", "patch" to "Patch", "dockerfile" to "Dockerfile", "makefile" to "Makefile", "graphql" to "GraphQL",
        "markdown" to "Markdown", "md" to "Markdown", "text" to "text", "txt" to "text", "plaintext" to "text",
        "vue" to "Vue", "svelte" to "Svelte", "zig" to "Zig", "objc" to "Objective-C", "env" to ".env",
    )

    private fun resolve(language: String?): Lang? {
        val key = language?.trim()?.lowercase()?.removePrefix(".") ?: return null
        if (key.isEmpty()) return null
        return ALIASES[key]
    }

    // ------------------------------------------------------------------ span sink

    private class SpanSink {
        private var data = IntArray(96)
        private var size = 0

        fun add(token: Token, start: Int, end: Int) {
            if (end <= start) return
            val t = token.ordinal
            // Merge with previous adjacent span of the same token.
            if (size >= 3 && data[size - 3] == t && data[size - 1] == start) {
                data[size - 1] = end
                return
            }
            if (size + 3 > data.size) data = data.copyOf(data.size * 2)
            data[size++] = t; data[size++] = start; data[size++] = end
        }

        fun toArray(): IntArray = data.copyOf(size)
    }

    private fun isIdentStart(c: Char) = c.isLetter() || c == '_'
    private fun isIdentPart(c: Char) = c.isLetterOrDigit() || c == '_'

    /** Scans a numeric literal starting at [i]; returns the end index. */
    private fun scanNumber(s: String, i: Int): Int {
        var j = i
        val n = s.length
        if (s[j] == '0' && j + 1 < n && (s[j + 1] == 'x' || s[j + 1] == 'X' || s[j + 1] == 'b' || s[j + 1] == 'B' || s[j + 1] == 'o' || s[j + 1] == 'O')) {
            j += 2
            while (j < n && (s[j].isLetterOrDigit() || s[j] == '_')) j++
            return j
        }
        while (j < n && (s[j].isDigit() || s[j] == '_')) j++
        if (j < n && s[j] == '.' && j + 1 < n && s[j + 1].isDigit()) {
            j++
            while (j < n && (s[j].isDigit() || s[j] == '_')) j++
        }
        if (j < n && (s[j] == 'e' || s[j] == 'E')) {
            var k = j + 1
            if (k < n && (s[k] == '+' || s[k] == '-')) k++
            if (k < n && s[k].isDigit()) {
                j = k
                while (j < n && s[j].isDigit()) j++
            }
        }
        while (j < n && (s[j] == 'f' || s[j] == 'F' || s[j] == 'L' || s[j] == 'l' || s[j] == 'u' || s[j] == 'U' || s[j] == 'n' || s[j] == 'd' || s[j] == 'D' || s[j] == 'm' || s[j] == 'M')) j++
        return j
    }

    /** Scans a quoted string starting at the quote at [i]; returns the end index (exclusive). */
    private fun scanString(s: String, i: Int, quote: Char, multiline: Boolean): Int {
        var j = i + 1
        val n = s.length
        while (j < n) {
            val c = s[j]
            if (c == '\\') {
                j += 2; continue
            }
            if (c == quote) return j + 1
            if (c == '\n' && !multiline) return j
            j++
        }
        return n
    }

    // ------------------------------------------------------------------ generic C-like/scripting lexer

    private class GenericLexer(private val spec: Spec, private val s: String, private val out: SpanSink) {
        private val n = s.length

        fun run() {
            var i = 0
            var lineStart = true
            while (i < n) {
                val c = s[i]
                if (c == '\n') {
                    lineStart = true; i++; continue
                }
                if (c == ' ' || c == '\t' || c == '\r') {
                    i++; continue
                }
                val wasLineStart = lineStart
                lineStart = false

                // Block comments
                val bc = spec.blockComment
                if (bc != null && s.startsWith(bc.first, i)) {
                    val end = s.indexOf(bc.second, i + bc.first.length).let { if (it < 0) n else it + bc.second.length }
                    out.add(Token.COMMENT, i, end); i = end; continue
                }
                // Line comments
                if (spec.lineComments.any { s.startsWith(it, i) } ||
                    (spec.hashComments && c == '#' && (i == 0 || s[i - 1].isWhitespace() || wasLineStart) && !(spec.annotationChar == '#' && i + 1 < n && s[i + 1] == '['))
                ) {
                    val end = s.indexOf('\n', i).let { if (it < 0) n else it }
                    out.add(Token.COMMENT, i, end); i = end; continue
                }
                // Preprocessor directives
                if (spec.preprocessor && c == '#' && wasLineStart) {
                    var j = i + 1
                    while (j < n && (s[j] == ' ')) j++
                    while (j < n && isIdentPart(s[j])) j++
                    out.add(Token.ANNOTATION, i, j); i = j; continue
                }
                // Shell prompt in console snippets: "$ " at line start
                if (spec.variableChar == '$' && c == '$' && wasLineStart && i + 1 < n && s[i + 1] == ' ') {
                    out.add(Token.PUNCTUATION, i, i + 1); i++; continue
                }
                // Triple-quoted strings
                if (spec.tripleQuotes && (s.startsWith("\"\"\"", i) || s.startsWith("'''", i))) {
                    val q = s.substring(i, i + 3)
                    val end = s.indexOf(q, i + 3).let { if (it < 0) n else it + 3 }
                    out.add(Token.STRING, i, end); i = end; continue
                }
                // Strings
                if (spec.quotes.indexOf(c) >= 0) {
                    if (c == '\'' && spec.rustLifetimes && i + 2 < n && isIdentStart(s[i + 1]) && s[i + 2] != '\'') {
                        var j = i + 1
                        while (j < n && isIdentPart(s[j])) j++
                        if (j >= n || s[j] != '\'') {
                            out.add(Token.ANNOTATION, i, j); i = j; continue
                        }
                    }
                    val end = scanString(s, i, c, multiline = false)
                    out.add(Token.STRING, i, end); i = end; continue
                }
                if (spec.backtickStrings && c == '`') {
                    val end = scanString(s, i, '`', multiline = true)
                    out.add(Token.STRING, i, end); i = end; continue
                }
                // Numbers
                if (c.isDigit() || (c == '.' && i + 1 < n && s[i + 1].isDigit() && (i == 0 || !isIdentPart(s[i - 1])))) {
                    if (i > 0 && isIdentPart(s[i - 1])) {
                        i++; continue
                    }
                    val end = scanNumber(s, i)
                    out.add(Token.NUMBER, i, end); i = end; continue
                }
                // Annotations / decorators / attributes
                val ac = spec.annotationChar
                if (ac != null && c == ac && i + 1 < n) {
                    if (ac == '#' && s[i + 1] == '[') {
                        val end = s.indexOf(']', i).let { if (it < 0) n else it + 1 }
                        out.add(Token.ANNOTATION, i, end); i = end; continue
                    }
                    if (isIdentStart(s[i + 1])) {
                        var j = i + 1
                        while (j < n && (isIdentPart(s[j]) || s[j] == '.')) j++
                        out.add(Token.ANNOTATION, i, j); i = j; continue
                    }
                }
                // Variables ($x, ${x}, @x for ruby handled by annotationChar)
                val vc = spec.variableChar
                if (vc != null && c == vc && i + 1 < n) {
                    if (s[i + 1] == '{') {
                        val end = s.indexOf('}', i).let { if (it < 0) n else it + 1 }
                        out.add(Token.TYPE, i, end); i = end; continue
                    }
                    if (s[i + 1] == '(') {
                        out.add(Token.PUNCTUATION, i, i + 2); i += 2; continue
                    }
                    var j = i + 1
                    while (j < n && (isIdentPart(s[j]) || (j == i + 1 && (s[j] == '?' || s[j] == '@' || s[j] == '#' || s[j] == '!' || s[j].isDigit())))) {
                        j++
                        if (j == i + 2 && !isIdentPart(s[i + 1])) break
                    }
                    if (j > i + 1) {
                        val word = s.substring(i, j)
                        out.add(if (word.lowercase() in spec.literals) Token.NUMBER else Token.TYPE, i, j); i = j; continue
                    }
                }
                // Ruby symbols
                if (spec.symbols && c == ':' && i + 1 < n && isIdentStart(s[i + 1]) && (i == 0 || !isIdentPart(s[i - 1]) && s[i - 1] != ':')) {
                    var j = i + 1
                    while (j < n && (isIdentPart(s[j]) || s[j] == '?' || s[j] == '!')) j++
                    out.add(Token.ANNOTATION, i, j); i = j; continue
                }
                // Identifiers
                if (isIdentStart(c) || c == '$') {
                    var j = i + 1
                    while (j < n && (isIdentPart(s[j]) || (spec.dashCmdlets && s[j] == '-' && j + 1 < n && s[j + 1].isLetter()))) j++
                    // String prefixes like f"…", r'…'
                    if (j < n && (s[j] == '"' || s[j] == '\'') && s.substring(i, j) in spec.stringPrefixes) {
                        val q = s[j]
                        val end = if (spec.tripleQuotes && s.startsWith("$q$q$q", j)) {
                            s.indexOf("$q$q$q", j + 3).let { if (it < 0) n else it + 3 }
                        } else scanString(s, j, q, multiline = false)
                        out.add(Token.STRING, i, end); i = end; continue
                    }
                    classifyWord(i, j)
                    i = j
                    continue
                }
                // Punctuation / operators
                if (c in PUNCT_CHARS) {
                    out.add(Token.PUNCTUATION, i, i + 1)
                }
                i++
            }
        }

        private fun classifyWord(start: Int, end: Int) {
            val raw = s.substring(start, end)
            val word = if (spec.caseInsensitive) raw.lowercase() else raw
            val token = when {
                word in spec.keywords -> Token.KEYWORD
                word in spec.literals || raw in spec.literals -> Token.NUMBER
                word in spec.types -> Token.TYPE
                spec.dashCmdlets && raw.contains('-') -> Token.FUNCTION
                followedByParen(end) -> Token.FUNCTION
                word in spec.builtins -> Token.FUNCTION
                spec.capitalizedTypes && raw[0].isUpperCase() && raw.length > 1 && raw.any { it.isLowerCase() } -> Token.TYPE
                else -> null
            }
            if (token != null) out.add(token, start, end)
        }

        private fun followedByParen(end: Int): Boolean {
            var j = end
            while (j < n && s[j] == ' ') j++
            return j < n && s[j] == '('
        }
    }

    private const val PUNCT_CHARS = "{}()[];,.:+-*/%=<>!&|^~?"

    // ------------------------------------------------------------------ data formats

    private class JsonLexer(private val s: String, private val out: SpanSink) {
        fun run() {
            var i = 0
            val n = s.length
            while (i < n) {
                val c = s[i]
                when {
                    c == '"' -> {
                        val end = scanString(s, i, '"', multiline = false)
                        var j = end
                        while (j < n && (s[j] == ' ' || s[j] == '\t')) j++
                        out.add(if (j < n && s[j] == ':') Token.ATTRIBUTE else Token.STRING, i, end)
                        i = end
                    }
                    c == '/' && i + 1 < n && s[i + 1] == '/' -> {
                        val end = s.indexOf('\n', i).let { if (it < 0) n else it }
                        out.add(Token.COMMENT, i, end); i = end
                    }
                    c == '-' || c.isDigit() -> {
                        val start = i
                        if (c == '-') i++
                        if (i < n && s[i].isDigit()) {
                            val end = scanNumber(s, i)
                            out.add(Token.NUMBER, start, end); i = end
                        }
                    }
                    s.startsWith("true", i) || s.startsWith("null", i) -> {
                        out.add(Token.KEYWORD, i, i + 4); i += 4
                    }
                    s.startsWith("false", i) -> {
                        out.add(Token.KEYWORD, i, i + 5); i += 5
                    }
                    c in "{}[]:," -> {
                        out.add(Token.PUNCTUATION, i, i + 1); i++
                    }
                    else -> i++
                }
            }
        }
    }

    private class YamlLexer(private val s: String, private val out: SpanSink) {
        fun run() {
            var lineStart = 0
            val n = s.length
            while (lineStart < n) {
                val lineEnd = s.indexOf('\n', lineStart).let { if (it < 0) n else it }
                line(lineStart, lineEnd)
                lineStart = lineEnd + 1
            }
        }

        private fun line(start: Int, end: Int) {
            var i = start
            while (i < end && (s[i] == ' ' || s[i] == '\t')) i++
            if (i >= end) return
            if (s[i] == '#') {
                out.add(Token.COMMENT, i, end); return
            }
            if (s.startsWith("---", i) || s.startsWith("...", i)) {
                out.add(Token.PUNCTUATION, i, minOf(end, i + 3)); return
            }
            if (s[i] == '-' && (i + 1 >= end || s[i + 1] == ' ')) {
                out.add(Token.PUNCTUATION, i, i + 1); i++
                while (i < end && s[i] == ' ') i++
            }
            // key: value
            val colon = findKeyColon(i, end)
            if (colon > i) {
                out.add(Token.ATTRIBUTE, i, colon)
                out.add(Token.PUNCTUATION, colon, colon + 1)
                i = colon + 1
            }
            value(i, end)
        }

        private fun findKeyColon(from: Int, end: Int): Int {
            var j = from
            if (j < end && (s[j] == '"' || s[j] == '\'')) {
                j = scanString(s, j, s[j], multiline = false)
            }
            while (j < end) {
                val c = s[j]
                if (c == ':' && (j + 1 >= end || s[j + 1] == ' ')) return j
                if (c == '#' && j > from && s[j - 1] == ' ') return -1
                if (c == ' ' && j + 1 < end && s[j + 1] == '#') return -1
                j++
            }
            return -1
        }

        private fun value(from: Int, end: Int) {
            var i = from
            while (i < end && s[i] == ' ') i++
            if (i >= end) return
            val c = s[i]
            when {
                c == '"' || c == '\'' -> {
                    val e = scanString(s, i, c, multiline = false).coerceAtMost(end)
                    out.add(Token.STRING, i, e)
                    comment(e, end)
                }
                c == '&' || c == '*' -> {
                    var j = i + 1
                    while (j < end && !s[j].isWhitespace()) j++
                    out.add(Token.ANNOTATION, i, j)
                }
                c == '|' || c == '>' -> out.add(Token.PUNCTUATION, i, i + 1)
                else -> {
                    val hash = s.indexOf(" #", i).let { if (it < 0 || it >= end) end else it }
                    val word = s.substring(i, hash).trim()
                    val lower = word.lowercase()
                    val token = when {
                        lower in YAML_LITERALS -> Token.KEYWORD
                        word.isNotEmpty() && (word[0].isDigit() || word[0] == '-' && word.length > 1 && word[1].isDigit()) &&
                            word.all { it.isDigit() || it in ".-+eE_xXoO:" } -> Token.NUMBER
                        else -> Token.STRING
                    }
                    out.add(token, i, i + word.length)
                    comment(hash, end)
                }
            }
        }

        private fun comment(from: Int, end: Int) {
            val h = s.indexOf('#', from)
            if (h in from until end) out.add(Token.COMMENT, h, end)
        }
    }

    private val YAML_LITERALS = setOf("true", "false", "yes", "no", "on", "off", "null", "~")

    private class TomlLexer(private val s: String, private val out: SpanSink) {
        fun run() {
            var lineStart = 0
            val n = s.length
            while (lineStart < n) {
                val end = s.indexOf('\n', lineStart).let { if (it < 0) n else it }
                var i = lineStart
                while (i < end && (s[i] == ' ' || s[i] == '\t')) i++
                if (i < end) {
                    when {
                        s[i] == '#' || s[i] == ';' -> out.add(Token.COMMENT, i, end)
                        s[i] == '[' -> out.add(Token.TYPE, i, s.indexOf(']', i).let { if (it < 0 || it > end) end else it + 1 })
                        else -> {
                            val eq = s.indexOf('=', i).let { if (it < 0 || it > end) -1 else it }
                            if (eq > i) {
                                out.add(Token.ATTRIBUTE, i, eq)
                                out.add(Token.PUNCTUATION, eq, eq + 1)
                                var v = eq + 1
                                while (v < end && s[v] == ' ') v++
                                var valueEnd = end
                                if (v < end) {
                                    val c = s[v]
                                    valueEnd = when {
                                        c == '"' || c == '\'' -> scanString(s, v, c, false).coerceAtMost(end)
                                        else -> s.indexOf(" #", v).let { h -> if (h < 0 || h >= end) end else h }
                                    }
                                    val token = when {
                                        c == '"' || c == '\'' -> Token.STRING
                                        c.isDigit() || ((c == '-' || c == '+') && v + 1 < valueEnd && s[v + 1].isDigit()) -> Token.NUMBER
                                        s.startsWith("true", v) || s.startsWith("false", v) -> Token.KEYWORD
                                        else -> Token.STRING
                                    }
                                    out.add(token, v, valueEnd)
                                }
                                val hash = s.indexOf('#', valueEnd).let { if (it < 0 || it >= end) -1 else it }
                                if (hash >= 0) out.add(Token.COMMENT, hash, end)
                            }
                        }
                    }
                }
                lineStart = end + 1
            }
        }
    }

    private class MarkupLexer(private val s: String, private val out: SpanSink) {
        fun run() {
            var i = 0
            val n = s.length
            while (i < n) {
                if (s.startsWith("<!--", i)) {
                    val end = s.indexOf("-->", i + 4).let { if (it < 0) n else it + 3 }
                    out.add(Token.COMMENT, i, end); i = end; continue
                }
                if (s.startsWith("<![CDATA[", i)) {
                    val end = s.indexOf("]]>", i).let { if (it < 0) n else it + 3 }
                    out.add(Token.STRING, i, end); i = end; continue
                }
                if (s[i] == '<' && i + 1 < n && (s[i + 1].isLetter() || s[i + 1] == '/' || s[i + 1] == '!' || s[i + 1] == '?')) {
                    i = tag(i)
                    continue
                }
                if (s[i] == '&') {
                    val semi = s.indexOf(';', i)
                    if (semi in (i + 2)..(i + 10)) {
                        out.add(Token.NUMBER, i, semi + 1); i = semi + 1; continue
                    }
                }
                i++
            }
        }

        private fun tag(start: Int): Int {
            val n = s.length
            var i = start + 1
            out.add(Token.PUNCTUATION, start, i)
            if (i < n && (s[i] == '/' || s[i] == '!' || s[i] == '?')) {
                out.add(Token.PUNCTUATION, i, i + 1); i++
            }
            val nameStart = i
            while (i < n && (s[i].isLetterOrDigit() || s[i] == '-' || s[i] == ':' || s[i] == '_' || s[i] == '.')) i++
            out.add(if (s.getOrNull(start + 1) == '!' || s.getOrNull(start + 1) == '?') Token.ANNOTATION else Token.TAG, nameStart, i)
            while (i < n) {
                val c = s[i]
                when {
                    c == '>' -> {
                        out.add(Token.PUNCTUATION, i, i + 1); return i + 1
                    }
                    c == '/' && i + 1 < n && s[i + 1] == '>' -> {
                        out.add(Token.PUNCTUATION, i, i + 2); return i + 2
                    }
                    c == '"' || c == '\'' -> {
                        val end = scanString(s, i, c, multiline = true)
                        out.add(Token.STRING, i, end); i = end
                    }
                    c == '=' -> {
                        out.add(Token.PUNCTUATION, i, i + 1); i++
                    }
                    c.isLetter() || c == '_' || c == ':' || c == '@' -> {
                        val a = i
                        while (i < n && (s[i].isLetterOrDigit() || s[i] in "-_:.@")) i++
                        out.add(Token.ATTRIBUTE, a, i)
                    }
                    c == '<' -> return i
                    else -> i++
                }
            }
            return n
        }
    }

    private class CssLexer(private val s: String, private val out: SpanSink) {
        fun run() {
            var i = 0
            val n = s.length
            var depth = 0
            var inValue = false
            while (i < n) {
                val c = s[i]
                when {
                    s.startsWith("/*", i) -> {
                        val end = s.indexOf("*/", i + 2).let { if (it < 0) n else it + 2 }
                        out.add(Token.COMMENT, i, end); i = end
                    }
                    s.startsWith("//", i) && (i == 0 || s[i - 1] != ':') -> {
                        val end = s.indexOf('\n', i).let { if (it < 0) n else it }
                        out.add(Token.COMMENT, i, end); i = end
                    }
                    c == '"' || c == '\'' -> {
                        val end = scanString(s, i, c, multiline = false)
                        out.add(Token.STRING, i, end); i = end
                    }
                    c == '{' -> {
                        depth++; inValue = false; out.add(Token.PUNCTUATION, i, i + 1); i++
                    }
                    c == '}' -> {
                        depth = (depth - 1).coerceAtLeast(0); inValue = false; out.add(Token.PUNCTUATION, i, i + 1); i++
                    }
                    c == ';' -> {
                        inValue = false; out.add(Token.PUNCTUATION, i, i + 1); i++
                    }
                    c == '@' -> {
                        var j = i + 1
                        while (j < n && (s[j].isLetterOrDigit() || s[j] == '-')) j++
                        out.add(Token.KEYWORD, i, j); i = j
                    }
                    c == '$' -> {
                        var j = i + 1
                        while (j < n && (s[j].isLetterOrDigit() || s[j] == '-' || s[j] == '_')) j++
                        out.add(Token.TYPE, i, j); i = j
                    }
                    c == '!' && s.startsWith("!important", i) -> {
                        out.add(Token.KEYWORD, i, i + 10); i += 10
                    }
                    inValue && c == '#' -> {
                        var j = i + 1
                        while (j < n && s[j].isLetterOrDigit()) j++
                        out.add(Token.NUMBER, i, j); i = j
                    }
                    inValue && (c.isDigit() || (c == '.' && i + 1 < n && s[i + 1].isDigit()) || (c == '-' && i + 1 < n && s[i + 1].isDigit())) -> {
                        var j = i + 1
                        while (j < n && (s[j].isDigit() || s[j] == '.')) j++
                        while (j < n && (s[j].isLetter() || s[j] == '%')) j++
                        out.add(Token.NUMBER, i, j); i = j
                    }
                    c.isLetter() || c == '-' || c == '_' || c == '.' || c == '#' || c == '*' || c == '&' || (c == ':' && depth == 0) -> {
                        var j = i
                        while (j < n && (s[j].isLetterOrDigit() || s[j] in "-_.#*&:>~+[]=\"'()")) {
                            if (s[j] == ':' && depth > 0 && !inValue) break
                            j++
                        }
                        if (j == i) j = i + 1
                        val token = when {
                            inValue -> if (j < n && s[j] == '(') Token.FUNCTION else Token.STRING
                            depth > 0 && nextNonSpace(j) == ':' -> Token.ATTRIBUTE
                            else -> Token.TAG
                        }
                        out.add(token, i, j); i = j
                    }
                    c == ':' -> {
                        if (depth > 0) inValue = true
                        out.add(Token.PUNCTUATION, i, i + 1); i++
                    }
                    else -> i++
                }
            }
        }

        private fun nextNonSpace(from: Int): Char? {
            var j = from
            while (j < s.length && s[j] == ' ') j++
            return s.getOrNull(j)
        }
    }

    private class DiffLexer(private val s: String, private val out: SpanSink) {
        fun run() {
            var start = 0
            val n = s.length
            while (start < n) {
                val end = s.indexOf('\n', start).let { if (it < 0) n else it }
                if (end > start) {
                    val token = when {
                        s.startsWith("+++", start) || s.startsWith("---", start) -> Token.KEYWORD
                        s.startsWith("@@", start) -> Token.ANNOTATION
                        s[start] == '+' -> Token.STRING
                        s[start] == '-' -> Token.TAG
                        s.startsWith("diff ", start) || s.startsWith("index ", start) -> Token.COMMENT
                        else -> null
                    }
                    if (token != null) out.add(token, start, end)
                }
                start = end + 1
            }
        }
    }
}
