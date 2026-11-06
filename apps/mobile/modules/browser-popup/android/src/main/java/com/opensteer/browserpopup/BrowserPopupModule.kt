package com.opensteer.browserpopup
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.graphics.Color
import android.graphics.ColorSpace
import android.os.Build
import android.view.View
import android.view.KeyEvent
import java.lang.ref.WeakReference
import android.view.ViewGroup
import android.widget.*
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import org.json.JSONObject

class BrowserPopupModule:Module() {
  private val fence=PopupFence()
  private var dialog:AlertDialog?=null
  private var child:AlertDialog?=null
  private var content:LinearLayout?=null
  private var pending=false
  override fun definition()=ModuleDefinition {
    Name("BrowserPopup")
    Constants("popupPresentationVersion" to if(Build.VERSION.SDK_INT>=26)1 else 0)
    Events("onAction")
    AsyncFunction("present") { id:String,revision:String,state:Map<String,Any?>->install(id,revision,state) }.runOnQueue(Queues.MAIN)
    AsyncFunction("update") { id:String,revision:String,state:Map<String,Any?>->if(fence.id==id)install(id,revision,state) else false }.runOnQueue(Queues.MAIN)
    AsyncFunction("dismiss") { id:String->dismiss(id) }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { cancelCurrent() }
    OnDestroy { appContext.currentActivity?.runOnUiThread { cancelCurrent() } }
  }
  private fun emit(id:String,revision:String,answer:Map<String,Any?>?) {
    if(!fence.accept(id,revision)||answer!=null&&pending)return
    if(answer!=null){pending=true;dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled=false;disable(content)}
    sendEvent("onAction",mapOf("presentationId" to id,"revision" to revision,"action" to if(answer==null)"cancel" else "commit")+(if(answer==null)emptyMap() else mapOf("answer" to answer)))
    if(answer==null)dismiss(id)
  }
  private fun disable(view:View?){view?.isEnabled=false;if(view is ViewGroup)for(i in 0 until view.childCount)disable(view.getChildAt(i))}
  private fun dismiss(id:String) {
    if(fence.id!=id)return
    fence.dismiss(id);pending=false
    child?.setOnCancelListener(null);child?.dismiss();child=null
    dialog?.setOnCancelListener(null);dialog?.setOnDismissListener(null);dialog?.dismiss();dialog=null
    content?.removeAllViews();content=null
  }
  private fun cancelCurrent(){val id=fence.id?:return;val revision=fence.revision?:return;emit(id,revision,null)}
  private fun install(id:String,revision:String,raw:Map<String,Any?>):Boolean {
    val activity=appContext.currentActivity?:return false
    if(Build.VERSION.SDK_INT<26||id.length>128||revision.length>20)return false
    val state=try{JSONObject(raw)}catch(_:Exception){return false}
    if(state.toString().toByteArray(Charsets.UTF_8).size>524288)return false
    val kind=state.optString("kind");if(kind !in listOf("select","date","time","datetime-local","month","week","color"))return false
    fence.id?.let{dismiss(it)};fence.present(id,revision)
    val box=LinearLayout(activity);content=box;box.orientation=LinearLayout.VERTICAL;box.setPadding(24,16,24,16);box.layoutDirection=if(state.optBoolean("rtl"))View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
    if(state.has("notice")){val notice=TextView(activity);notice.text=state.optString("notice");box.addView(notice)}
    val exact=EditText(activity);var draft=state.optString("value");exact.setText(draft);exact.contentDescription=if(kind=="color")"Exact CSS color" else "Exact value";exact.setSingleLine(true)
    val selected=mutableSetOf<String>()
    val items=state.optJSONArray("items");if((items?.length()?:0)>1024){dismiss(id);return false}
    val rows=(0 until (items?.length()?:0)).map{items!!.getJSONObject(it)}
    rows.filter{it.optBoolean("selected")&&it.optBoolean("enabled")&&it.optString("kind")=="option"}.forEach{selected.add(it.getString("id"))}
    fun parts()=PopupCalendar.parse(exact.text.toString(),kind)?:PopupCalendar.Parts()
    val calendarRepresentable=parts().year in 1..9999
    if(!calendarRepresentable){val label=TextView(activity);label.text="Use exact entry for this calendar value.";box.addView(label)}
    fun showTime(p:PopupCalendar.Parts){
      val picker=TimePickerDialog(activity,{_,h,m->if(fence.accept(id,revision)){p.hour=h;p.minute=m;draft=p.value(kind);exact.setText(draft)}},p.hour,p.minute,true)
      child=picker;picker.setOnCancelListener{emit(id,revision,null)};picker.show()
    }
    if(calendarRepresentable&&kind in listOf("date","time","datetime-local")) {
      val button=Button(activity);button.text=if(kind=="time")"Time picker" else "Date picker"
      button.setOnClickListener{
        val p=parts()
        if(kind=="time")showTime(p) else {
          val picker=DatePickerDialog(activity,{_,y,m,d->if(fence.accept(id,revision)){p.year=y;p.month=m+1;p.day=d;draft=p.value(kind);exact.setText(draft);if(kind=="datetime-local")showTime(p)}},p.year.coerceIn(1,9999),p.month-1,p.day)
          child=picker;picker.setOnCancelListener{emit(id,revision,null)};picker.show()
        }
      };box.addView(button)
    } else if(calendarRepresentable&&(kind=="month"||kind=="week")) {
      val p=parts();val row=LinearLayout(activity);val year=NumberPicker(activity);year.minValue=1;year.maxValue=9999;year.value=p.year.coerceIn(1,9999)
      val part=NumberPicker(activity);part.minValue=1;part.maxValue=if(kind=="month")12 else 53;part.value=if(kind=="month")p.month else p.week
      year.contentDescription="Year";part.contentDescription=if(kind=="month")"Month" else "ISO week"
      fun changed(){p.year=year.value;p.month=part.value;p.week=part.value;exact.setText(p.value(kind))}
      year.setOnValueChangedListener{_,_,_->changed()};part.setOnValueChangedListener{_,_,_->changed()};row.addView(year);row.addView(part);box.addView(row)
    } else if(kind=="color") {
      val space=if(state.optString("colorSpace")=="display-p3")ColorSpace.get(ColorSpace.Named.DISPLAY_P3) else ColorSpace.get(ColorSpace.Named.SRGB)
      val initial=parseColor(draft)?.convert(space)
      if(initial!=null) {
        val channels=initial.components.copyOf()
        for(index in 0..(if(state.optBoolean("alpha"))3 else 2)) {
          val label=TextView(activity);label.text=listOf("Red","Green","Blue","Alpha")[index];box.addView(label)
          val slider=SeekBar(activity);slider.max=1000;slider.progress=(channels[index]*1000).toInt();slider.contentDescription=label.text
          slider.setOnSeekBarChangeListener(object:SeekBar.OnSeekBarChangeListener{
            override fun onProgressChanged(bar:SeekBar?,progress:Int,fromUser:Boolean){if(!fromUser)return;channels[index]=progress/1000f;val alpha=if(state.optBoolean("alpha"))channels[3] else 1f;draft="color(${state.optString("colorSpace")} ${channels[0]} ${channels[1]} ${channels[2]} / $alpha)";exact.setText(draft)}
            override fun onStartTrackingTouch(bar:SeekBar?){};override fun onStopTrackingTouch(bar:SeekBar?){}
          });box.addView(slider)
        }
      }
    }
    if(kind!="select"){val label=TextView(activity);label.text=exact.contentDescription;box.addView(label);box.addView(exact)}
    if(rows.isNotEmpty()) {
      val list=ListView(activity)
      list.adapter=object:ArrayAdapter<JSONObject>(activity,android.R.layout.simple_list_item_multiple_choice,android.R.id.text1,rows) {
        override fun isEnabled(position:Int):Boolean {val i=rows[position];return i.optBoolean("enabled")&&i.optString("kind") in listOf("option","suggestion")}
        override fun areAllItemsEnabled()=false
        override fun getView(position:Int,convertView:View?,parent:ViewGroup):View {
          val v=super.getView(position,convertView,parent);val i=rows[position]
          val primary=v.findViewById<CheckedTextView>(android.R.id.text1);primary.text=listOf(i.optString("label"),i.optString("secondaryLabel")).filter{it.isNotEmpty()}.joinToString("\n");primary.isEnabled=isEnabled(position)
          primary.isChecked=selected.contains(i.optString("id"))||i.optBoolean("selected")&&!i.optBoolean("enabled")
          primary.checkMarkDrawable?.alpha=if(i.optString("kind") in listOf("option","suggestion"))255 else 0
          v.layoutDirection=if(i.optBoolean("rtl"))View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
          return v
        }
      }
      list.setOnItemClickListener{_,_,position,_->
        val item=rows[position];if(!item.optBoolean("enabled")||pending)return@setOnItemClickListener
        val itemId=item.getString("id")
        if(kind=="select"&&state.optBoolean("multiple")){if(!selected.remove(itemId))selected.add(itemId);(list.adapter as BaseAdapter).notifyDataSetChanged()}
        else emit(id,revision,mapOf("itemIds" to listOf(itemId)))
      }
      box.addView(list,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,(minOf(rows.size,8)*56*activity.resources.displayMetrics.density).toInt()))
    }
    val scroll=ScrollView(activity);scroll.addView(box)
    val title=when(kind){"select"->"Choose an option";"color"->"Choose a color";"datetime-local"->"Choose a date";else->"Choose a $kind"}
    val created=AlertDialog.Builder(activity).setTitle(title).setView(scroll).setNegativeButton("Cancel"){_,_->emit(id,revision,null)}.setPositiveButton("Done",null).create()
    val openingFocus=WeakReference(activity.currentFocus)
    val keyReleases=PopupKeyReleases()
    created.setOnKeyListener{_,code,event->
      if(code==KeyEvent.KEYCODE_ESCAPE){if(event.action==KeyEvent.ACTION_UP)emit(id,revision,null);true}
      else if(event.action==KeyEvent.ACTION_DOWN){keyReleases.began(code);false}
      else if(event.action==KeyEvent.ACTION_UP&&keyReleases.ended(code)){openingFocus.get()?.dispatchKeyEvent(event);true}
      else false
    }
    dialog=created;created.setOnCancelListener{emit(id,revision,null)};created.show()
    created.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled=kind!="select"||state.optBoolean("multiple")||selected.size==1
    created.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener{emit(id,revision,if(kind=="select")mapOf("itemIds" to selected.toList()) else mapOf("value" to exact.text.toString()))}
    return true
  }
  private fun parseColor(value:String):Color? {
    if(Build.VERSION.SDK_INT<26)return null
    return try {
      if(value.startsWith("#")) {
        // CSS hex puts alpha last; Android's parser puts it first.
        val hex=if(value.length==9)"#"+value.takeLast(2)+value.substring(1,7) else value
        Color.valueOf(Color.parseColor(hex))
      } else {
        val m=Regex("^color\\((srgb|display-p3) ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: / ([0-9.]+))?\\)$").matchEntire(value)?:return null
        val space=ColorSpace.get(if(m.groupValues[1]=="display-p3")ColorSpace.Named.DISPLAY_P3 else ColorSpace.Named.SRGB)
        Color.valueOf(m.groupValues[2].toFloat(),m.groupValues[3].toFloat(),m.groupValues[4].toFloat(),m.groupValues[5].toFloatOrNull()?:1f,space)
      }
    }catch(_:Exception){null}
  }
}
