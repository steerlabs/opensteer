package com.opensteer.browserpopup
import java.util.Locale
class PopupFence {
  var id:String?=null; private set
  var revision:String?=null; private set
  fun present(id:String,revision:String) {this.id=id;this.revision=revision}
  fun dismiss(id:String) {if(this.id==id){this.id=null;revision=null}}
  fun accept(id:String,revision:String)=this.id==id&&this.revision==revision
}
object PopupCalendar {
  data class Parts(var year:Int=1970,var month:Int=1,var day:Int=1,var hour:Int=0,var minute:Int=0,var second:Int=0,var week:Int=1,var fraction:String="") {
    fun value(kind:String):String {
      val date=String.format(Locale.ROOT,"%04d-%02d-%02d",year,month,day)
      val time=String.format(Locale.ROOT,"%02d:%02d:%02d",hour,minute,second)+fraction
      return when(kind){"date"->date;"time"->time;"month"->String.format(Locale.ROOT,"%04d-%02d",year,month);"week"->String.format(Locale.ROOT,"%04d-W%02d",year,week);else->date+"T"+time}
    }
  }
  fun parse(value:String,kind:String):Parts? {
    if(value.toByteArray(Charsets.UTF_8).size>4096)return null
    val pattern=when(kind){"date"->"^(\\d{4,})-(\\d{2})-(\\d{2})$";"month"->"^(\\d{4,})-(\\d{2})$";"week"->"^(\\d{4,})-W(\\d{2})$";"time"->"^(\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,3})?)?$";else->"^(\\d{4,})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,3})?)?$"}
    val m=Regex(pattern).matchEntire(value)?:return null
    fun n(i:Int,default:Int=0)=m.groupValues.getOrElse(i){""}.toIntOrNull()?:default
    val p=Parts()
    if(kind=="time"){p.hour=n(1);p.minute=n(2);p.second=n(3);p.fraction=m.groupValues[4]}
    else {
      p.year=n(1);if(p.year !in 1..275760)return null
      val leap=p.year%4==0&&(p.year%100!=0||p.year%400==0)
      if(kind=="week") {p.week=n(2);val before=p.year-1;val jan1=(before+before/4-before/100+before/400+1)%7;val max=if(jan1==4||jan1==3&&leap)53 else 52;return if(p.week in 1..max)p else null}
      p.month=n(2);p.day=if(kind=="month")1 else n(3)
      if(kind=="datetime-local"){p.hour=n(4);p.minute=n(5);p.second=n(6);p.fraction=m.groupValues[7]}
      val months=intArrayOf(31,if(leap)29 else 28,31,30,31,30,31,31,30,31,30,31)
      if(p.month !in 1..12||p.day !in 1..months[p.month-1])return null
    }
    return if(p.hour in 0..23&&p.minute in 0..59&&p.second in 0..59)p else null
  }
}

class PopupKeyReleases {
  private val local=mutableSetOf<Int>()
  private val forwarded=mutableSetOf<Int>()
  fun began(code:Int){if(local.size<128)local.add(code)}
  fun ended(code:Int):Boolean {if(local.remove(code))return false;return forwarded.size<128&&forwarded.add(code)}
}
