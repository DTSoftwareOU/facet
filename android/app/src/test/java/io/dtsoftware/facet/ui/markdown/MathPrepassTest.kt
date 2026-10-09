package io.dtsoftware.facet.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MathPrepassTest {

    private fun formulas(src: String) = MathPrepass.protect(src).formulas.map { it.latex }

    @Test
    fun currencyIsNotMath() {
        assertTrue(formulas("It costs $5 and $10 in total.").isEmpty())
        assertTrue(formulas("Between $5-$10 per month").isEmpty())
        assertTrue(formulas("Prices: $1,000 or $2,500.").isEmpty())
        assertTrue(formulas("Pay $ 5 now and $ 6 later").isEmpty())
        assertTrue(formulas("$5$").isEmpty())
    }

    @Test
    fun inlineDollarMath() {
        assertEquals(listOf("x^2", "y_1"), formulas("Let \$x^2\$ and \$y_1\$ be values."))
        assertEquals(listOf("\\frac{a}{b}"), formulas("ratio \$\\frac{a}{b}\$."))
    }

    @Test
    fun parenAndBracketDelimiters() {
        assertEquals(listOf("a+b"), formulas("sum \\(a+b\\) here"))
        val r = MathPrepass.protect("display \\[\\int_0^1 x\\,dx\\] inline")
        assertEquals(1, r.formulas.size)
        assertTrue(r.formulas[0].display)
    }

    @Test
    fun inParagraphDoubleDollarIsDisplay() {
        val r = MathPrepass.protect("Energy \$\$E=mc^2\$\$ is famous")
        assertEquals("E=mc^2", r.formulas.single().latex)
        assertTrue(r.formulas.single().display)
    }

    @Test
    fun codeIsUntouched() {
        assertTrue(formulas("Use `\$x\$` literally").isEmpty())
        assertTrue(formulas("```bash\necho \$HOME \$PATH\nx=\$a\$b\n```").isEmpty())
        assertTrue(formulas("Run ``a \$b\$ c`` ok").isEmpty())
    }

    @Test
    fun escapedDollarIsLiteral() {
        assertTrue(formulas("\\\$x\$ nope").isEmpty())
    }

    @Test
    fun noNewlineInsideInlineMath() {
        assertTrue(formulas("\$a\nb\$").isEmpty())
    }

    @Test
    fun placeholdersReplaceFormulas() {
        val r = MathPrepass.protect("A \$x_1\$ B")
        assertFalse(r.text.contains("x_1"))
        assertTrue(r.text.contains(MathPrepass.OPEN))
    }
}
