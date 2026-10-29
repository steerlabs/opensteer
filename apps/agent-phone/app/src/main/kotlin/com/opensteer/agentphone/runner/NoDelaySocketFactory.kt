package com.opensteer.agentphone.runner

import java.net.InetAddress
import java.net.Socket
import javax.net.SocketFactory

/**
 * Sockets that send a small write at once. Android sockets default to Nagle's
 * algorithm, which holds a write back until the previous one is acknowledged;
 * against a peer that delays its acknowledgements, that stalls live display
 * frames and owner input by hundreds of milliseconds. The Host and Cloudflare's
 * edge already send without delay, so the phone is the end that must say so.
 */
class NoDelaySocketFactory(private val delegate: SocketFactory = getDefault()) : SocketFactory() {
    override fun createSocket(): Socket = delegate.createSocket().noDelay()

    override fun createSocket(host: String, port: Int): Socket = delegate.createSocket(host, port).noDelay()

    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
        delegate.createSocket(host, port, localHost, localPort).noDelay()

    override fun createSocket(host: InetAddress, port: Int): Socket = delegate.createSocket(host, port).noDelay()

    override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
        delegate.createSocket(address, port, localAddress, localPort).noDelay()

    private fun Socket.noDelay(): Socket = apply { tcpNoDelay = true }
}
