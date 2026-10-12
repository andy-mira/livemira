// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
#include "preprocess.h"
#include <iostream>
#include <vector>
#include <limits>
int main() {
  uint8_t rgb[] = {255,0,0,255,0,255,0,0,0,0,255,127}, gray[3] = {};
  if (e_rgba_gray(rgb,12,3,1,12,gray,3) || gray[0]!=77 || gray[1]!=149 || gray[2]!=29) return 1;
  if (!e_rgba_gray(rgb,11,3,1,12,gray,3) || !e_rgba_gray(rgb,12,0,1,12,gray,3)) return 2;
  if (!e_pyr_down(gray,3,1,3,std::numeric_limits<size_t>::max(),rgb,12)) return 3;
  std::vector<uint8_t> input(17*13*4), output(17*13), down(9*7);
  for (size_t i=0;i<input.size();++i) input[i]=uint8_t((i*73+19)%256);
  if (e_rgba_gray(input.data(),input.size(),17,13,68,output.data(),output.size())) return 4;
  if (e_pyr_down(output.data(),output.size(),17,13,17,down.data(),down.size())) return 5;
  for (auto value : output) std::cout << unsigned(value) << ' ';
  for (auto value : down) std::cout << unsigned(value) << ' ';
  return 0;
}
