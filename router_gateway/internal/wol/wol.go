package wol

import (
	"errors"
	"net"
	"strconv"
	"syscall"
)

func Send(macAddress, broadcast string) error {
	mac, err := net.ParseMAC(macAddress)
	if err != nil || len(mac) != 6 {
		return errors.New("invalid PC MAC")
	}
	ip := net.ParseIP(broadcast).To4()
	if ip == nil {
		return errors.New("invalid broadcast address")
	}
	packet := make([]byte, 102)
	for i := 0; i < 6; i++ {
		packet[i] = 0xff
	}
	for i := 0; i < 16; i++ {
		copy(packet[6+i*6:], mac)
	}
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: ip, Port: 9})
	if err != nil {
		return err
	}
	defer conn.Close()
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var socketError error
	if err := raw.Control(func(fd uintptr) {
		socketError = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
	}); err != nil {
		return err
	}
	if socketError != nil {
		return socketError
	}
	n, err := conn.Write(packet)
	if err != nil {
		return err
	}
	if n != len(packet) {
		return errors.New("incomplete WOL packet: " + strconv.Itoa(n))
	}
	return nil
}
