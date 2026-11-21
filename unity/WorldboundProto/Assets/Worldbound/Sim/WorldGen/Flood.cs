// Заполнение впадин (priority-flood) и дерево стока (src/sim/worldgen/flood.ts). Равные высоты — по индексу.
namespace Worldbound.Sim.WorldGen
{
    public static class Flood
    {
        public static readonly int[] DX8 = { 1, 1, 0, -1, -1, -1, 0, 1 };
        public static readonly int[] DZ8 = { 0, 1, 1, 1, 0, -1, -1, -1 };

        sealed class MinHeap
        {
            readonly int[] items;
            readonly double[] key;
            int size;

            public MinHeap(int capacity, double[] key)
            {
                items = new int[capacity];
                this.key = key;
            }

            public int Length => size;

            bool Less(int a, int b)
            {
                double ka = key[a], kb = key[b];
                return ka < kb || (ka == kb && a < b);
            }

            public void Push(int i)
            {
                int k = size++;
                items[k] = i;
                while (k > 0)
                {
                    int parent = (k - 1) >> 1;
                    if (!Less(items[k], items[parent])) break;
                    (items[k], items[parent]) = (items[parent], items[k]);
                    k = parent;
                }
            }

            public int Pop()
            {
                int top = items[0];
                int last = items[--size];
                if (size > 0)
                {
                    items[0] = last;
                    int k = 0;
                    for (;;)
                    {
                        int l = k * 2 + 1, r = l + 1, m = k;
                        if (l < size && Less(items[l], items[m])) m = l;
                        if (r < size && Less(items[r], items[m])) m = r;
                        if (m == k) break;
                        (items[k], items[m]) = (items[m], items[k]);
                        k = m;
                    }
                }
                return top;
            }
        }

        public static (double[] filled, int[] receiver, int[] order) Run(int n, double[] height, byte[] outlet, double epsilon)
        {
            int count = n * n;
            var filled = new double[count];
            var receiver = new int[count];
            var order = new int[count];
            var done = new byte[count];
            var heap = new MinHeap(count, filled);
            for (int i = 0; i < count; i++)
            {
                receiver[i] = -1;
                filled[i] = height[i];
                if (outlet[i] == 1)
                {
                    done[i] = 1;
                    heap.Push(i);
                }
            }
            int k = 0;
            while (heap.Length > 0)
            {
                int c = heap.Pop();
                order[k++] = c;
                int cx = c % n, cz = (c - cx) / n;
                double fc = filled[c];
                for (int d = 0; d < 8; d++)
                {
                    int x = cx + DX8[d], z = cz + DZ8[d];
                    if (x < 0 || z < 0 || x >= n || z >= n) continue;
                    int i = z * n + x;
                    if (done[i] == 1) continue;
                    done[i] = 1;
                    double h = height[i];
                    filled[i] = h > fc + epsilon ? h : fc + epsilon;
                    receiver[i] = c;
                    heap.Push(i);
                }
            }
            if (k < count) for (int i = 0; i < count; i++) if (done[i] == 0) order[k++] = i;
            return (filled, receiver, order);
        }
    }
}
