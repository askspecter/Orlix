package xyz.orlixai.keyboard

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.inputmethodservice.InputMethodService
import android.net.Uri
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Orlix Keyboard — a full QWERTY IME with an onchain suggestion strip.
 *
 * As the user types, we watch the word under the cursor. The moment it looks
 * like a ticker ($pepe, $degen, ...) we hit /api/keyboard?q= and render a live
 * chip: price, 24h change, an AI signal, and a 🚀 shortcut that deep-links into
 * the Orlix B20 launch flow. Everything degrades to plain typing offline.
 */
class OrlixKeyboardService : InputMethodService() {

    private companion object {
        const val API = "https://orlixai.xyz/api/keyboard"
        val TICKER = Regex("""\$([A-Za-z0-9]{2,12})$""")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var lookupJob: Job? = null

    private lateinit var strip: LinearLayout          // holds either trending chips or a result chip
    private lateinit var stripScroll: HorizontalScrollView
    private var caps = true                            // shift state
    private var lastQuery = ""

    // ---- lifecycle ----------------------------------------------------------

    override fun onCreateInputView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0A0908"))
            layoutParams = ViewGroup.LayoutParams(MATCH, WRAP)
        }
        root.addView(buildStrip())
        root.addView(buildKeys())
        return root
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        caps = true
        showTrending()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    // ---- suggestion strip ---------------------------------------------------

    private fun buildStrip(): View {
        stripScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            setBackgroundColor(Color.parseColor("#100E0C"))
            layoutParams = LinearLayout.LayoutParams(MATCH, dp(50))
        }
        strip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), 0, dp(10), 0)
        }
        stripScroll.addView(strip)
        return stripScroll
    }

    private fun brand(): TextView = TextView(this).apply {
        text = "orlix"
        setTextColor(Color.parseColor("#F07830"))
        setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setPadding(dp(6), 0, dp(12), 0)
    }

    private fun showTrending() {
        strip.removeAllViews()
        strip.addView(brand())
        val hint = TextView(this).apply {
            text = "type \$ticker for live price"
            setTextColor(Color.parseColor("#8A857E"))
            setTypeface(Typeface.MONOSPACE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        }
        strip.addView(hint)
    }

    private fun showLoading(sym: String) {
        strip.removeAllViews()
        strip.addView(brand())
        strip.addView(chip("\$${sym.uppercase()}", "…", Color.parseColor("#8A857E"), null))
    }

    private fun showResult(o: JSONObject) {
        strip.removeAllViews()
        strip.addView(brand())

        val sym = o.optString("symbol").uppercase()
        val price = o.optString("price", "?")
        // API sends ch24 pre-formatted ("+4.2%" / "-3.1%" / null) and an `up` flag.
        val ch = if (o.isNull("ch24")) "" else o.optString("ch24", "")
        val up = o.optBoolean("up", true)
        val signal = o.optString("signal", "")
        val insert = o.optString("insert", "\$$sym")

        val chColor = if (up) Color.parseColor("#4ADE80") else Color.parseColor("#F87171")
        val arrow = if (up) "▲" else "▼"
        val label = if (ch.isEmpty()) "\$$sym  $price" else "\$$sym  $price  $arrow $ch"

        // main chip → inserts the formatted snippet
        strip.addView(chip(label, null, chColor) {
            replaceTicker(insert)
            showTrending()
        })

        // signal pill
        if (signal.isNotEmpty()) {
            strip.addView(signalPill(signal))
        }

        // 🚀 launch shortcut → deep-link to Orlix launch flow
        strip.addView(chip("🚀 launch", null, Color.parseColor("#F0A070")) {
            openLaunch(sym)
        })
    }

    private fun chip(text: String, sub: String?, textColor: Int, onClick: (() -> Unit)?): View {
        val tv = TextView(this).apply {
            this.text = if (sub == null) text else "$text $sub"
            setTextColor(textColor)
            setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(12), dp(7), dp(12), dp(7))
            setBackgroundColor(Color.parseColor("#1A1815"))
            val lp = LinearLayout.LayoutParams(WRAP, WRAP)
            lp.marginEnd = dp(8)
            layoutParams = lp
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
            if (onClick != null) setOnClickListener { onClick() }
        }
        return tv
    }

    private fun signalPill(signal: String): View {
        val color = when (signal.uppercase()) {
            "RISKY" -> Color.parseColor("#F87171")
            "ACTIVE" -> Color.parseColor("#4ADE80")
            "WATCH" -> Color.parseColor("#F0A070")
            else -> Color.parseColor("#8A857E")
        }
        return TextView(this).apply {
            text = signal.uppercase()
            setTextColor(color)
            setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setPadding(dp(10), dp(6), dp(10), dp(6))
            val lp = LinearLayout.LayoutParams(WRAP, WRAP)
            lp.marginEnd = dp(8)
            layoutParams = lp
        }
    }

    // ---- ticker detection + network ----------------------------------------

    private fun onTextChanged() {
        val before = currentInputConnection?.getTextBeforeCursor(64, 0)?.toString() ?: ""
        val m = TICKER.find(before)
        if (m == null) {
            if (lastQuery.isNotEmpty()) { lastQuery = ""; showTrending() }
            return
        }
        val sym = m.groupValues[1]
        if (sym.equals(lastQuery, ignoreCase = true)) return
        lastQuery = sym
        lookupJob?.cancel()
        lookupJob = scope.launch {
            delay(220)                    // debounce keystrokes
            showLoading(sym)
            val json = withContext(Dispatchers.IO) { fetch(sym) }
            if (json != null && json.optBoolean("found", false)) {
                val tok = json.optJSONObject("token")
                if (tok != null) showResult(tok) else showTrending()
            } else {
                strip.removeAllViews()
                strip.addView(brand())
                strip.addView(chip("\$${sym.uppercase()}", "not found", Color.parseColor("#8A857E"), null))
            }
        }
    }

    private fun fetch(sym: String): JSONObject? = try {
        val url = URL("$API?q=" + URLEncoder.encode(sym, "UTF-8"))
        (url.openConnection() as HttpURLConnection).run {
            connectTimeout = 4000
            readTimeout = 4000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
            if (responseCode == 200) JSONObject(inputStream.bufferedReader().readText())
            else null
        }
    } catch (e: Exception) { null }

    private fun replaceTicker(insert: String) {
        val ic = currentInputConnection ?: return
        val before = ic.getTextBeforeCursor(64, 0)?.toString() ?: ""
        val m = TICKER.find(before) ?: return
        ic.deleteSurroundingText(m.value.length, 0)
        ic.commitText(insert, 1)
        lastQuery = ""
    }

    private fun openLaunch(sym: String) {
        try {
            val i = Intent(Intent.ACTION_VIEW, Uri.parse("https://orlixai.xyz/b20-studio.html?launch=$sym"))
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(i)
        } catch (e: Exception) { /* no browser */ }
    }

    // ---- QWERTY keyboard ----------------------------------------------------

    private val rows = listOf(
        "qwertyuiop",
        "asdfghjkl",
        "zxcvbnm"
    )

    private fun buildKeys(): View {
        val kb = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(3), dp(4), dp(3), dp(6))
        }

        for ((idx, row) in rows.withIndex()) {
            val rl = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
            }
            // last letter row: shift + backspace flank the letters
            if (idx == 2) rl.addView(funcKey("⇧", 1.5f) { toggleShift() })
            for (c in row) rl.addView(letterKey(c))
            if (idx == 2) rl.addView(funcKey("⌫", 1.5f) { backspace() })
            kb.addView(rl)
        }

        // bottom row: $ · symbols-ish, space, . , enter
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
        }
        bottom.addView(funcKey("\$", 1.4f) { commit("$") })
        bottom.addView(funcKey(",", 1f) { commit(",") })
        bottom.addView(funcKey("space", 4f) { commit(" ") })
        bottom.addView(funcKey(".", 1f) { commit(".") })
        bottom.addView(funcKey("↵", 1.6f) { enter() })
        kb.addView(bottom)

        return kb
    }

    private fun letterKey(c: Char): View = Button(this).apply {
        text = c.toString()
        layoutParams = LinearLayout.LayoutParams(0, dp(46), 1f).also { it.setMargins(dp(2), dp(2), dp(2), dp(2)) }
        setBackgroundColor(Color.parseColor("#1A1815"))
        setTextColor(Color.parseColor("#EDEDED"))
        setTypeface(Typeface.MONOSPACE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setPadding(0, 0, 0, 0)
        isAllCaps = false
        transformationMethod = null
        setOnClickListener {
            commit(if (caps) c.uppercase() else c.toString())
            if (caps) caps = false   // auto-drop shift after one capital
        }
    }

    private fun funcKey(label: String, weight: Float, onClick: () -> Unit): View = Button(this).apply {
        text = label
        layoutParams = LinearLayout.LayoutParams(0, dp(46), weight).also { it.setMargins(dp(2), dp(2), dp(2), dp(2)) }
        setBackgroundColor(Color.parseColor("#141210"))
        setTextColor(Color.parseColor("#F0A070"))
        setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        isAllCaps = false
        setPadding(0, 0, 0, 0)
        setOnClickListener { onClick() }
    }

    private fun toggleShift() { caps = !caps /* case is applied on the next keypress */ }

    private fun commit(s: String) {
        currentInputConnection?.commitText(s, 1)
        onTextChanged()
    }

    private fun backspace() {
        currentInputConnection?.deleteSurroundingText(1, 0)
        onTextChanged()
    }

    private fun enter() {
        val ic = currentInputConnection ?: return
        val action = currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
        if (action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            ic.commitText("\n", 1)
        }
    }

    // ---- utils --------------------------------------------------------------

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt()

    private val MATCH get() = ViewGroup.LayoutParams.MATCH_PARENT
    private val WRAP get() = ViewGroup.LayoutParams.WRAP_CONTENT
}
