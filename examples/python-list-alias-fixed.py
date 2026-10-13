def change(values):
    values[len(values) - 1] = 99
    values.append(42)
    return values

original = [3, 1, 2]
copy = [original[0], original[1], original[2]]
changed = change(copy)
result = original[2]  # a lista original permanece intacta
print(original)
