# The app reaches BouncyCastle only through its lightweight Ed25519 classes,
# which R8 keeps by reachability; nothing is loaded reflectively.
