package com.opensteer.display

import android.content.Context
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.EGLExt
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.ScaleGestureDetector
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** The codec writes one output at a time into our texture, which we latch and
 * compose ourselves. The output TextureView timestamp commits the exact token. */
class BrowserVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext), TextureView.SurfaceTextureListener {
  val onReady by EventDispatcher()
  val onNeedsKeyframe by EventDispatcher()
  val onVideoPresented by EventDispatcher()
  val onVideoGesture by EventDispatcher()
  val onVideoTap by EventDispatcher()
  val onVideoScroll by EventDispatcher()
  private val texture = TextureView(context).apply { surfaceTextureListener = this@BrowserVideoView }
  private val cover = View(context).apply { setBackgroundColor(Color.BLACK) }
  private val thread = HandlerThread("opensteer-browser-video").apply { start() }
  private val worker = Handler(thread.looper)
  private val pending = AtomicInteger()
  @Volatile private var epoch = ""
  @Volatile private var revision = 0L
  @Volatile private var decodeRevision = 0L
  @Volatile private var showing = false
  @Volatile private var outputSurface: SurfaceTexture? = null
  private data class Composition(val frame:FrameMetadata,val timestamp:Long,val revision:Long)
  @Volatile private var committed: Composition? = null
  @Volatile private var swapped: Composition? = null
  @Volatile private var zoom=1.0
  private var latched:FrameMetadata?=null
  private var redrawPending=false
  private var initialized=false
  private var gesture: Gesture? = null
  private var codec: MediaCodec? = null
  private var codecWidth = 0; private var codecHeight = 0
  private val reference = KeyframeFence()
  private val inputs = ArrayDeque<Int>()
  private data class Packet(val bytes: ByteArray, val frame: FrameMetadata, val promise: Promise, val revision: Long, val arrival: Long)
  private val packets = ArrayDeque<Packet>()
  private val frames = HashMap<Long, FrameMetadata>()
  private val outputs = ArrayDeque<Pair<Int, FrameMetadata>>()
  private var latching: FrameMetadata? = null
  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var glContext: EGLContext = EGL14.EGL_NO_CONTEXT
  private var glSurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var inputTexture: SurfaceTexture? = null
  private var codecSurface: Surface? = null
  private var textureId = 0; private var program = 0
  private var destroyed = false
  private data class Gesture(val frame: FrameMetadata, val id: String, val x: Double, val y: Double, val localX: Float, val localY: Float, val revision: Long, var lastX: Float = localX, var lastY: Float = localY, var scrolling: Boolean = false)
  private val pinch = ScaleGestureDetector(context, object: ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScale(detector: ScaleGestureDetector): Boolean {cancelGesture();revision++;committed=null;zoom=(zoom*detector.scaleFactor).coerceIn(1.0,4.0);worker.post{if(swapped==null)renderLatched()else redrawPending=true};return true}
  })
  init { addView(texture); addView(cover); initialized=true }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    texture.layout(0,0,width,height); cover.layout(0,0,width,height)
    if(changed) { revision++; committed = null; cancelGesture() }
  }
  fun reset(next: String) { reset(next, false) }
  private fun reset(next: String, clearPicture: Boolean) {
    cancelGesture(); decodeRevision++; reference.lost()
    if(next != epoch || clearPicture) { revision++; committed=null; cover.visibility=View.VISIBLE }
    epoch=next; worker.post { release() }
  }
  fun decode(bytes: ByteArray, frame: FrameMetadata, promise: Promise) {
    val stamp = decodeRevision
    val arrival = reference.arrive()
    if(!showing || destroyed || outputSurface == null || frame.epoch != epoch || !frame.pts.isFinite() || frame.pts < 0 || frame.pts > 9_007_199_254_740_991.0 || frame.identity.length > 16_384 || bytes.isEmpty() || bytes.size > 4_194_304) { reference.lost(arrival); worker.post { release() }; promise.resolve(false); return }
    if(pending.incrementAndGet()>4){pending.decrementAndGet();reference.lost(arrival);worker.post{release()};promise.resolve(false);return}
    worker.post {
      try {
        require(frame.epoch==epoch && stamp==decodeRevision && showing && reference.allows(frame.key))
        if(frame.key)require(H264VideoConfig.valid(bytes,frame.width,frame.height))
        if(codec!=null && (frame.width!=codecWidth || frame.height!=codecHeight)){require(frame.key);release()}
        if(codec==null){require(frame.key);configure(frame)}
        val packet=Packet(bytes,frame,promise,stamp,arrival);packets.addLast(packet)
        // A missing native input-buffer callback has one bounded admission deadline.
        worker.postDelayed({if(packets.remove(packet)){pending.decrementAndGet();packet.promise.resolve(false);reference.lost();post{onNeedsKeyframe(mapOf("epoch" to frame.epoch))}}},1000)
        admitInputs()
      }catch(_:Exception){pending.decrementAndGet();promise.resolve(false);release();post{onNeedsKeyframe(mapOf("epoch" to frame.epoch))}}
    }
  }
  private fun admitInputs(){
    val decoder=codec?:return
    while(inputs.isNotEmpty() && packets.isNotEmpty() && frames.size<8){
      val packet=packets.removeFirst();val frame=packet.frame
      try{
        require(frame.epoch==epoch && packet.revision==decodeRevision && showing && reference.allows(frame.key))
        val index=inputs.removeFirst();val buffer=requireNotNull(decoder.getInputBuffer(index));require(buffer.capacity()>=packet.bytes.size && !frames.containsKey(frame.pts.toLong()))
        buffer.clear();buffer.put(packet.bytes);frames[frame.pts.toLong()]=frame
        decoder.queueInputBuffer(index,0,packet.bytes.size,frame.pts.toLong(),0);reference.enqueued(frame.key,packet.arrival);packet.promise.resolve(true)
      }catch(_:Exception){packet.promise.resolve(false);release();post{onNeedsKeyframe(mapOf("epoch" to frame.epoch))}}
      finally{pending.decrementAndGet()}
    }
  }
  private fun configure(frame: FrameMetadata) {
    setupGl(requireNotNull(outputSurface))
    codecWidth = frame.width; codecHeight = frame.height
    val format = MediaFormat.createVideoFormat("video/avc",frame.width,frame.height)
    val decoder = MediaCodec.createByCodecName(requireNotNull(MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format)))
    codec = decoder
    decoder.setCallback(object: MediaCodec.Callback() {
      override fun onInputBufferAvailable(c: MediaCodec,index: Int) { if(codec === c) {inputs.addLast(index);admitInputs()} }
      override fun onOutputBufferAvailable(c: MediaCodec,index: Int,info: MediaCodec.BufferInfo) {
        if(codec !== c)return
        val item = frames.remove(info.presentationTimeUs)
        if(item == null || item.epoch != epoch || item.replayed || !showing) { c.releaseOutputBuffer(index,false); admitInputs(); return }
        if(outputs.size >= 8) { release(); post { onNeedsKeyframe(mapOf("epoch" to epoch)) }; return }
        outputs.addLast(index to item); drain();admitInputs()
      }
      override fun onOutputFormatChanged(c: MediaCodec,format: MediaFormat) {
        val visibleWidth = if(format.containsKey("crop-right")) format.getInteger("crop-right") - format.getInteger("crop-left") + 1 else format.getInteger(MediaFormat.KEY_WIDTH)
        val visibleHeight = if(format.containsKey("crop-bottom")) format.getInteger("crop-bottom") - format.getInteger("crop-top") + 1 else format.getInteger(MediaFormat.KEY_HEIGHT)
        if(visibleWidth != codecWidth || visibleHeight != codecHeight) { release(); post { onNeedsKeyframe(mapOf("epoch" to epoch)) } }
      }
      override fun onError(c: MediaCodec,error: MediaCodec.CodecException) { if(codec === c) { release(); post { onNeedsKeyframe(mapOf("epoch" to epoch)) } } }
    },worker)
    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE,4_194_304)
    if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && decoder.codecInfo.getCapabilitiesForType("video/avc").isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency))format.setInteger(MediaFormat.KEY_LOW_LATENCY,1)
    decoder.configure(format,codecSurface,null,0); decoder.start()
  }
  private fun drain() {
    if(latching != null || swapped != null || outputs.isEmpty())return
    val (index,frame) = outputs.removeFirst(); latching = frame
    codec?.releaseOutputBuffer(index,true)
    worker.postDelayed({if(latching===frame){release();post{onNeedsKeyframe(mapOf("epoch" to epoch))}}},1000)
  }
  private fun latch() {
    val input = inputTexture ?: return
    val frame = latching ?: return
    try {
      require(EGL14.eglMakeCurrent(display,glSurface,glSurface,glContext))
      input.updateTexImage()
      // No newest-frame guess: a coalesced or unmatched buffer closes input and recovers.
      require(input.timestamp == frame.pts.toLong() * 1000 && frame.epoch == epoch && showing)
      latched=frame;latching=null;renderLatched()
    } catch(_: Exception) { swapped = null; release(); post { onNeedsKeyframe(mapOf("epoch" to epoch)) } }
  }
  private fun renderLatched(){
    val source=latched?:return
    if(swapped!=null){redrawPending=true;return}
    val frame=FrameMetadata().apply {epoch=source.epoch;width=source.width;height=source.height;pts=source.pts;key=source.key;replayed=source.replayed;identity=source.identity;cropWidth=contentWidth(source)/zoom;cropHeight=contentHeight(source)/zoom;cropX=source.cropX+(contentWidth(source)-cropWidth)/2;cropY=source.cropY+(contentHeight(source)-cropHeight)/2}
    try{
      require(EGL14.eglMakeCurrent(display,glSurface,glSurface,glContext))
      val input=inputTexture?:return
      val target = rect(frame) ?: error("Invalid browser content crop")
      val transform = FloatArray(16); input.getTransformMatrix(transform)
      GLES20.glViewport(0,0,width,height); GLES20.glClearColor(0f,0f,0f,1f); GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      GLES20.glViewport(target[0].toInt(),height-target[3].toInt(),(target[2]-target[0]).toInt(),(target[3]-target[1]).toInt())
      GLES20.glUseProgram(program); GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,textureId)
      GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"video"),0)
      GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program,"transform"),1,false,transform,0)
      GLES20.glUniform4f(GLES20.glGetUniformLocation(program,"crop"),(frame.cropX/frame.width).toFloat(),(frame.cropY/frame.height).toFloat(),(contentWidth(frame)/frame.width).toFloat(),(contentHeight(frame)/frame.height).toFloat())
      val vertices = ByteBuffer.allocateDirect(8*4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(floatArrayOf(-1f,-1f,1f,-1f,-1f,1f,1f,1f)).apply { position(0) }
      val at = GLES20.glGetAttribLocation(program,"position"); GLES20.glEnableVertexAttribArray(at); GLES20.glVertexAttribPointer(at,2,GLES20.GL_FLOAT,false,0,vertices)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4); GLES20.glDisableVertexAttribArray(at)
      val composition=Composition(frame,System.nanoTime(),revision);swapped = composition; latching = null
      EGLExt.eglPresentationTimeANDROID(display,glSurface,composition.timestamp)
      require(EGL14.eglSwapBuffers(display,glSurface))
      worker.postDelayed({if(swapped===composition){release();post{onNeedsKeyframe(mapOf("epoch" to epoch))}}},1000)
    }catch(_:Exception){release();post{onNeedsKeyframe(mapOf("epoch" to epoch))}}
  }
  private fun setupGl(output: SurfaceTexture) {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY); require(display != EGL14.EGL_NO_DISPLAY)
    require(EGL14.eglInitialize(display,IntArray(2),0,IntArray(2),0))
    val configs = arrayOfNulls<EGLConfig>(1); val count = IntArray(1)
    require(EGL14.eglChooseConfig(display,intArrayOf(EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_NONE),0,configs,0,1,count,0))
    glContext = EGL14.eglCreateContext(display,configs[0],EGL14.EGL_NO_CONTEXT,intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE),0)
    val surface = Surface(output)
    try { glSurface = EGL14.eglCreateWindowSurface(display,configs[0],surface,intArrayOf(EGL14.EGL_NONE),0) } finally { surface.release() }
    require(EGL14.eglMakeCurrent(display,glSurface,glSurface,glContext))
    val ids = IntArray(1); GLES20.glGenTextures(1,ids,0); textureId=ids[0]; GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,textureId)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR); GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR)
    inputTexture = SurfaceTexture(textureId).apply { setOnFrameAvailableListener({ latch() },worker) }; codecSurface = Surface(inputTexture)
    fun shader(type: Int, source: String): Int { val result=GLES20.glCreateShader(type);GLES20.glShaderSource(result,source);GLES20.glCompileShader(result);val status=IntArray(1);GLES20.glGetShaderiv(result,GLES20.GL_COMPILE_STATUS,status,0);require(status[0]!=0);return result }
    val vertex=shader(GLES20.GL_VERTEX_SHADER,"attribute vec2 position;varying vec2 uv;void main(){gl_Position=vec4(position,0.,1.);uv=vec2((position.x+1.)/2.,(1.-position.y)/2.);}")
    val fragment=shader(GLES20.GL_FRAGMENT_SHADER,"#extension GL_OES_EGL_image_external : require\nprecision mediump float;varying vec2 uv;uniform samplerExternalOES video;uniform mat4 transform;uniform vec4 crop;void main(){gl_FragColor=texture2D(video,(transform*vec4(crop.xy+uv*crop.zw,0.,1.)).xy);}")
    program=GLES20.glCreateProgram();GLES20.glAttachShader(program,vertex);GLES20.glAttachShader(program,fragment);GLES20.glLinkProgram(program);GLES20.glDeleteShader(vertex);GLES20.glDeleteShader(fragment)
    val linked=IntArray(1);GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,linked,0);require(linked[0]!=0)
  }
  private fun release() {
    while(packets.isNotEmpty()){packets.removeFirst().promise.resolve(false);pending.decrementAndGet()};val old=codec;codec=null;runCatching{old?.stop()};runCatching{old?.release()};inputs.clear();frames.clear();outputs.clear();latching=null;swapped=null;latched=null;redrawPending=false;reference.lost()
    codecSurface?.release();codecSurface=null;inputTexture?.release();inputTexture=null
    if(display != EGL14.EGL_NO_DISPLAY){if(program!=0)GLES20.glDeleteProgram(program);if(textureId!=0)GLES20.glDeleteTextures(1,intArrayOf(textureId),0);EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);EGL14.eglDestroySurface(display,glSurface);EGL14.eglDestroyContext(display,glContext);EGL14.eglTerminate(display)}
    display=EGL14.EGL_NO_DISPLAY;glSurface=EGL14.EGL_NO_SURFACE;glContext=EGL14.EGL_NO_CONTEXT;program=0;textureId=0
  }
  override fun onSurfaceTextureAvailable(surface: SurfaceTexture,w: Int,h: Int) { outputSurface=surface;showing=windowVisibility==View.VISIBLE;onNeedsKeyframe(mapOf("epoch" to epoch)) }
  override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture,w: Int,h: Int) { committed=null;cancelGesture();revision++;worker.post{if(swapped==null)renderLatched()else redrawPending=true} }
  override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean { showing=false;outputSurface=null;reset(epoch, true);return true }
  override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
    val composition=swapped ?: return;val frame=composition.frame
    if(showing && frame.epoch==epoch && composition.revision==revision && surface.timestamp==composition.timestamp) {
      committed=composition;cover.visibility=View.GONE
      onReady(mapOf("epoch" to epoch,"width" to frame.width,"height" to frame.height));onVideoPresented(mapOf("epoch" to epoch,"identity" to frame.identity))
    } else {committed=null}
    if(surface.timestamp==composition.timestamp)worker.post { if(swapped===composition){swapped=null;if(redrawPending || composition.revision!=revision){redrawPending=false;renderLatched()}else drain()} }
    else {committed=null;cover.visibility=View.VISIBLE;worker.post{release()};onNeedsKeyframe(mapOf("epoch" to epoch))}
  }
  override fun onTouchEvent(event: MotionEvent): Boolean {
    pinch.onTouchEvent(event);if(pinch.isInProgress){cancelGesture();return true}
    when(event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val frame=committed?.frame ?: return true;val target=rect(frame) ?: return true
        if(event.x<target[0] || event.x>=target[2] || event.y<target[1] || event.y>=target[3])return true
        val id=UUID.randomUUID().toString();gesture=Gesture(frame,id,frame.cropX+(event.x-target[0])*contentWidth(frame)/(target[2]-target[0]),frame.cropY+(event.y-target[1])*contentHeight(frame)/(target[3]-target[1]),event.x,event.y,revision)
        onVideoGesture(mapOf("epoch" to epoch,"identity" to frame.identity,"gestureId" to id,"phase" to "begin"))
      }
      MotionEvent.ACTION_MOVE -> {
        val start=gesture
        if(start!=null){
          if(kotlin.math.hypot((event.x-start.localX).toDouble(),(event.y-start.localY).toDouble())>8*resources.displayMetrics.density && !start.scrolling){start.scrolling=true;cancel(start)}
          val target=rect(start.frame)
          if(start.scrolling && target!=null)onVideoScroll(mapOf("epoch" to start.frame.epoch,"identity" to start.frame.identity,"x" to start.x,"y" to start.y,"dx" to (start.lastX-event.x)*contentWidth(start.frame)/(target[2]-target[0]),"dy" to (start.lastY-event.y)*contentHeight(start.frame)/(target[3]-target[1])))
          start.lastX=event.x;start.lastY=event.y
        }
      }
      MotionEvent.ACTION_UP -> {val start=gesture;gesture=null;if(start!=null){if(!start.scrolling && start.revision==revision && start.frame.epoch==epoch)onVideoTap(mapOf("epoch" to epoch,"identity" to start.frame.identity,"gestureId" to start.id,"x" to start.x,"y" to start.y))else if(!start.scrolling)cancel(start)}}
      MotionEvent.ACTION_CANCEL,MotionEvent.ACTION_POINTER_DOWN -> cancelGesture()
    };return true
  }
  private fun cancel(start: Gesture) {onVideoGesture(mapOf("epoch" to start.frame.epoch,"identity" to start.frame.identity,"gestureId" to start.id,"phase" to "cancel"))}
  private fun cancelGesture(){gesture?.takeIf{!it.scrolling}?.let(::cancel);gesture=null}
  private fun contentWidth(f:FrameMetadata)=if(f.cropWidth>0)f.cropWidth else f.width.toDouble()
  private fun contentHeight(f:FrameMetadata)=if(f.cropHeight>0)f.cropHeight else f.height.toDouble()
  private fun rect(f:FrameMetadata):DoubleArray? {val w=contentWidth(f);val h=contentHeight(f);if(w<=0 || h<=0 || f.cropX<0 || f.cropY<0 || f.cropX+w>f.width || f.cropY+h>f.height || width<=0 || height<=0)return null;val scale=minOf(width/w,height/h);val x=(width-w*scale)/2;val y=(height-h*scale)/2;return doubleArrayOf(x,y,x+w*scale,y+h*scale)}
  override fun onWindowVisibilityChanged(visibility: Int){super.onWindowVisibilityChanged(visibility);showing=visibility==View.VISIBLE;if(!showing && initialized && !destroyed)reset(epoch, true)}
  override fun onDetachedFromWindow(){showing=false;reset(epoch, true);super.onDetachedFromWindow()}
  fun destroy(){if(destroyed)return;destroyed=true;showing=false;reset("");worker.post{release();thread.quitSafely()}}
}
