select 
	w.UseID
	,wu.Description
	,wu.Income
	,sum(w.Amount) * case when wu.income = 1 then 1 else -1 end as Total
from 
	FCT_WealthData as w
inner JOIN
	vw_const as v
on
	v.RaceID = w.RaceID
left JOIN
	DIM_WealthUse as wu
on
	wu.WealthUseID = w.UseID
WHERE
	w.TimeUsed >= v.GameTime - 365.0 * 24 * 60 * 60
group by
	w.UseID
order by 4 desc