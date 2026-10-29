package com.opensteer.agentphone.fixture

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.util.Base64
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri

/** The fixture's record of every interaction, in order. A file survives the fixture's process being killed. */
class Receipts(context: Context) : SQLiteOpenHelper(context.applicationContext, "receipts.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE receipts (_id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun record(kind: String, detail: String) {
        writableDatabase.insert(
            "receipts",
            null,
            ContentValues().apply {
                put("at", System.currentTimeMillis())
                put("kind", kind)
                put("detail", detail)
            },
        )
    }
}

/**
 * `content://com.opensteer.agentphone.fixture.receipts/receipts`:
 * `adb shell content query --uri <that>` lists every receipt in order, and
 * `adb shell content delete --uri <that>` clears them between steps.
 */
class ReceiptsProvider : ContentProvider() {
    private lateinit var receipts: Receipts

    override fun onCreate(): Boolean {
        receipts = Receipts(requireNotNull(context))
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val rows = receipts.readableDatabase.query("receipts", arrayOf("_id", "at", "kind", "detail"), null, null, null, null, "_id")
        if (projection?.contains("detailBase64") != true) return rows
        return rows.use {
            MatrixCursor(arrayOf("_id", "at", "kind", "detailBase64")).apply {
                while (rows.moveToNext()) addRow(arrayOf(rows.getLong(0), rows.getLong(1), rows.getString(2),
                    Base64.encodeToString(rows.getString(3).toByteArray(Charsets.UTF_8), Base64.NO_WRAP)))
            }
        }
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        receipts.writableDatabase.delete("receipts", null, null)

    override fun getType(uri: Uri): String = "vnd.android.cursor.dir/vnd.opensteer.receipt"

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
